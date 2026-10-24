export type StratumStatus = 'idle' | 'connecting' | 'authorizing' | 'mining' | 'error'

export interface StratumJob {
  jobId: string
  prevhash: string
  coinb1: string
  coinb2: string
  merkleBranch: string[]
  version: string
  nbits: string
  ntime: string
  extraNonce1: string
  extraNonce2Size: number
  miningDiff: number
  /** When true the pool has invalidated every earlier job, so their shares are dead. */
  cleanJobs: boolean
}

export interface StratumHandlers {
  onStatus: (status: StratumStatus, detail?: string) => void
  onJob: (job: StratumJob) => void
  onDifficulty: (diff: number) => void
  onShare: (accepted: boolean, detail: string) => void
  onLog: (line: string) => void
}

export interface StratumOptions {
  relay: string
  host: string
  port: number
  worker: string
  password: string
}

interface RpcMessage {
  id?: number | null
  method?: string
  result?: unknown
  error?: unknown
  params?: unknown[]
}

/**
 * Stratum over WebSocket. Browsers cannot open raw TCP sockets, so the pool
 * address is base64-encoded into the relay's URL path and the relay bridges
 * the WebSocket to a plain TCP connection.
 */
export class StratumClient {
  private ws: WebSocket | null = null
  private buffer = ''
  private nextId = 1
  private pending = new Map<number, (msg: RpcMessage) => void>()
  private difficulty = 0
  private extraNonce1 = ''
  private extraNonce2Size = 4
  private stopped = false
  private submitted = new Set<string>()

  constructor(
    private readonly options: StratumOptions,
    private readonly handlers: StratumHandlers,
  ) {}

  connect() {
    this.stopped = false
    this.handlers.onStatus('connecting')

    const target = `${this.options.host}:${this.options.port}`
    const url = `${this.options.relay.replace(/\/+$/, '')}/${btoa(target)}`
    this.handlers.onLog(`relay ${this.options.relay.replace('wss://', '')}`)
    this.handlers.onLog(`pool ${target}`)

    let socket: WebSocket
    try {
      socket = new WebSocket(url)
    } catch (err) {
      this.handlers.onStatus('error', 'Cannot open relay socket')
      this.handlers.onLog(`error: ${(err as Error).message}`)
      return
    }
    this.ws = socket

    socket.onopen = () => {
      this.handlers.onLog('relay connected, subscribing')
      this.request('mining.subscribe', ['browser-miner/1.0']).then((msg) => {
        const result = msg.result as [unknown, string, number] | null
        if (!result) {
          this.handlers.onStatus('error', 'Subscribe rejected')
          return
        }
        this.extraNonce1 = result[1]
        this.extraNonce2Size = result[2]
        this.handlers.onLog(`extranonce1 ${this.extraNonce1} (size ${this.extraNonce2Size})`)
        this.handlers.onStatus('authorizing')
        return this.request('mining.authorize', [this.options.worker, this.options.password])
      }).then((msg) => {
        if (!msg) return
        if (msg.result === true) {
          this.handlers.onLog('authorized, waiting for job')
          this.handlers.onStatus('mining')
        } else {
          this.handlers.onStatus('error', 'Pool rejected the wallet address')
          this.handlers.onLog(`authorize failed: ${JSON.stringify(msg.error)}`)
        }
      }).catch(() => {
        this.handlers.onStatus('error', 'Handshake failed')
      })
    }

    socket.onmessage = (event) => this.receive(String(event.data))

    socket.onerror = () => {
      if (this.stopped) return
      this.handlers.onStatus('error', 'Relay connection error')
      this.handlers.onLog('relay socket error')
    }

    socket.onclose = () => {
      if (this.stopped) return
      this.handlers.onStatus('error', 'Relay closed the connection')
      this.handlers.onLog('relay socket closed')
    }
  }

  disconnect() {
    this.stopped = true
    this.pending.clear()
    if (this.ws) {
      this.ws.onopen = null
      this.ws.onmessage = null
      this.ws.onerror = null
      this.ws.onclose = null
      try {
        this.ws.close()
      } catch {
        // already closed
      }
      this.ws = null
    }
    this.handlers.onStatus('idle')
  }

  submit(jobId: string, extraNonce2: string, ntime: string, nonce: string) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    // A resubmitted nonce is a guaranteed duplicate reject, so it never leaves.
    const key = `${jobId}:${extraNonce2}:${nonce}`
    if (this.submitted.has(key)) return
    this.submitted.add(key)
    if (this.submitted.size > 1024) this.submitted.clear()

    this.request('mining.submit', [this.options.worker, jobId, extraNonce2, ntime, nonce])
      .then((msg) => {
        const accepted = msg.result === true
        const detail = accepted ? 'accepted' : JSON.stringify(msg.error)
        this.handlers.onShare(accepted, detail)
        this.handlers.onLog(`share ${accepted ? 'accepted' : 'rejected'} ${accepted ? '' : detail}`)
      })
      .catch(() => this.handlers.onShare(false, 'no response'))
  }

  private request(method: string, params: unknown[]): Promise<RpcMessage> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('socket not open'))
        return
      }
      const id = this.nextId++
      this.pending.set(id, resolve)
      this.ws.send(JSON.stringify({ id, method, params }) + '\n')
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method} timed out`))
      }, 20_000)
    })
  }

  private receive(chunk: string) {
    this.buffer += chunk
    const lines = this.buffer.split('\n')
    this.buffer = lines.pop() ?? ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      let msg: RpcMessage
      try {
        msg = JSON.parse(trimmed)
      } catch {
        continue
      }
      this.dispatch(msg)
    }
  }

  private dispatch(msg: RpcMessage) {
    if (typeof msg.id === 'number' && this.pending.has(msg.id)) {
      const resolve = this.pending.get(msg.id)!
      this.pending.delete(msg.id)
      resolve(msg)
      return
    }

    if (msg.method === 'mining.set_difficulty') {
      this.difficulty = Number((msg.params as number[])[0]) || 0
      this.handlers.onDifficulty(this.difficulty)
      this.handlers.onLog(`difficulty ${this.difficulty}`)
      return
    }

    if (msg.method === 'mining.notify') {
      const p = msg.params as [
        string,
        string,
        string,
        string,
        string[],
        string,
        string,
        string,
        boolean?,
      ]
      this.handlers.onJob({
        jobId: p[0],
        prevhash: p[1],
        coinb1: p[2],
        coinb2: p[3],
        merkleBranch: p[4],
        version: p[5],
        nbits: p[6],
        ntime: p[7],
        extraNonce1: this.extraNonce1,
        extraNonce2Size: this.extraNonce2Size,
        miningDiff: this.difficulty,
        // zpool invalidates the previous job on every notify, so an absent flag
        // is treated as "clean" — submitting against a dead job only earns a
        // [21,"Invalid job id"] reject.
        cleanJobs: p[8] !== false,
      })
    }
  }
}
