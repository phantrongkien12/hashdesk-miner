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
  /**
   * A share the pool never answered. Kept apart from onShare because a timeout
   * says nothing about the share itself — counting it as a reject makes a slow
   * relay look like a broken miner.
   */
  onLost: (detail: string) => void
  onLog: (line: string) => void
}

export interface StratumOptions {
  /** Tried in order; the client rotates to the next one when a relay keeps failing. */
  relays: string[]
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

const MAX_BACKOFF_MS = 30_000
/** Failures on one relay before moving to the next. */
const FAILURES_PER_RELAY = 2

/**
 * Stratum over WebSocket. Browsers cannot open raw TCP sockets, so the pool
 * address is base64-encoded into the relay's URL path and the relay bridges
 * the WebSocket to a plain TCP connection.
 *
 * A dropped relay reconnects on its own with exponential backoff, rotating
 * through the relay list, because a miner left running for hours will outlive
 * any single relay instance.
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
  private relayIndex = 0
  private failures = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly options: StratumOptions,
    private readonly handlers: StratumHandlers,
  ) {}

  get relay(): string {
    return this.options.relays[this.relayIndex] ?? this.options.relays[0] ?? ''
  }

  connect() {
    this.stopped = false
    this.failures = 0
    this.open()
  }

  disconnect() {
    this.stopped = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
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
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.handlers.onLost('socket closed')
      return
    }
    // A resubmitted nonce is a guaranteed duplicate reject, so it never leaves.
    const key = `${jobId}:${extraNonce2}:${nonce}`
    if (this.submitted.has(key)) return
    this.submitted.add(key)
    if (this.submitted.size > 4096) this.submitted.clear()

    this.request('mining.submit', [this.options.worker, jobId, extraNonce2, ntime, nonce])
      .then((msg) => {
        const accepted = msg.result === true
        const detail = accepted ? 'accepted' : JSON.stringify(msg.error)
        this.handlers.onShare(accepted, detail)
        this.handlers.onLog(`share ${accepted ? 'accepted' : 'rejected'} ${accepted ? '' : detail}`)
      })
      .catch((err: Error) => {
        this.handlers.onLost(err.message)
        this.handlers.onLog(`share lost — ${err.message}`)
      })
  }

  private open() {
    this.handlers.onStatus('connecting')
    this.buffer = ''
    this.pending.clear()

    const target = `${this.options.host}:${this.options.port}`
    const url = `${this.relay.replace(/\/+$/, '')}/${btoa(target)}`
    this.handlers.onLog(`relay ${this.relay.replace('wss://', '')}`)
    this.handlers.onLog(`pool ${target}`)

    let socket: WebSocket
    try {
      socket = new WebSocket(url)
    } catch (err) {
      this.handlers.onLog(`error: ${(err as Error).message}`)
      this.scheduleReconnect('cannot open relay socket')
      return
    }
    this.ws = socket

    socket.onopen = () => {
      this.handlers.onLog('relay connected, subscribing')
      this.request('mining.subscribe', ['browser-miner/1.0']).then((msg) => {
        const result = msg.result as [unknown, string, number] | null
        if (!result) {
          this.handlers.onStatus('error', 'Subscribe rejected')
          this.scheduleReconnect('subscribe rejected')
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
          // The session is live, so this relay counts as healthy again.
          this.failures = 0
          this.handlers.onLog('authorized, waiting for job')
          this.handlers.onStatus('mining')
        } else {
          this.handlers.onStatus('error', 'Pool rejected the wallet address')
          this.handlers.onLog(`authorize failed: ${JSON.stringify(msg.error)}`)
        }
      }).catch(() => {
        this.scheduleReconnect('handshake failed')
      })
    }

    socket.onmessage = (event) => this.receive(String(event.data))

    socket.onerror = () => {
      if (this.stopped) return
      this.handlers.onLog('relay socket error')
    }

    socket.onclose = () => {
      if (this.stopped) return
      this.scheduleReconnect('relay closed the connection')
    }
  }

  private scheduleReconnect(reason: string) {
    if (this.stopped || this.reconnectTimer) return
    this.failures += 1

    if (this.failures % FAILURES_PER_RELAY === 0 && this.options.relays.length > 1) {
      this.relayIndex = (this.relayIndex + 1) % this.options.relays.length
      this.handlers.onLog(`switching to relay ${this.relay.replace('wss://', '')}`)
    }

    const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(this.failures - 1, 5))
    const seconds = Math.round(delay / 1000)
    this.handlers.onStatus('error', `${reason} — retrying in ${seconds}s`)
    this.handlers.onLog(`reconnect in ${seconds}s (attempt ${this.failures})`)

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (!this.stopped) this.open()
    }, delay)
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
