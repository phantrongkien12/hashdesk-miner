import { ALGOS, type AlgoId } from './coins'
import { StratumClient, type StratumJob, type StratumStatus } from './stratum'

export interface EngineConfig {
  algo: AlgoId
  payout: string
  wallet: string
  threads: number
  relay: string
}

export type EngineEvent =
  | { type: 'status'; status: StratumStatus; detail?: string }
  | { type: 'hashrate'; value: number }
  | { type: 'difficulty'; value: number }
  | { type: 'share'; accepted: boolean; detail: string }
  | { type: 'stale' }
  | { type: 'log'; line: string }
  | { type: 'job'; jobId: string }

interface WorkerMessage {
  type: 'ready' | 'hashrate' | 'share' | 'error'
  workerId?: string
  hashrate?: number
  message?: string
  data?: { jobId: string; extraNonce2: string; ntime: string; nonce: string }
}

export class MinerEngine {
  private workers: Worker[] = []
  private stratum: StratumClient | null = null
  private rates = new Map<string, number>()
  private currentJob: StratumJob | null = null
  private previousJob: StratumJob | null = null
  private paused = false
  private sampler: ReturnType<typeof setInterval> | null = null
  private running = false

  constructor(
    private readonly config: EngineConfig,
    private readonly emit: (event: EngineEvent) => void,
  ) {}

  start() {
    if (this.running) return
    this.running = true

    const algo = ALGOS[this.config.algo]
    this.emit({ type: 'log', line: `starting ${this.config.threads} thread(s) on ${algo.label}` })

    this.stratum = new StratumClient(
      {
        relay: this.config.relay,
        host: algo.host,
        port: algo.port,
        worker: this.config.wallet,
        password: `c=${this.config.payout}`,
      },
      {
        onStatus: (status, detail) => this.emit({ type: 'status', status, detail }),
        onJob: (job) => this.broadcast(job),
        onDifficulty: (value) => this.applyDifficulty(value),
        onShare: (accepted, detail) => this.emit({ type: 'share', accepted, detail }),
        onLog: (line) => this.emit({ type: 'log', line }),
      },
    )
    this.stratum.connect()

    this.spawnWorkers()
    this.startSampler()
  }

  /** Stops hashing but keeps the pool session and share counters, like xmrig's pause. */
  pause() {
    if (!this.running || this.paused) return
    this.paused = true
    this.stopWorkers()
    this.stopSampler()
    this.emit({ type: 'hashrate', value: 0 })
    this.emit({ type: 'log', line: 'paused' })
  }

  resume() {
    if (!this.running || !this.paused) return
    this.paused = false
    this.spawnWorkers()
    this.startSampler()
    if (this.currentJob) {
      for (const worker of this.workers) worker.postMessage(toWorkMessage(this.currentJob))
    }
    this.emit({ type: 'log', line: 'resumed' })
  }

  stop() {
    if (!this.running) return
    this.running = false
    this.paused = false

    this.stopSampler()
    this.stopWorkers()
    this.currentJob = null
    this.previousJob = null

    this.stratum?.disconnect()
    this.stratum = null
    this.emit({ type: 'hashrate', value: 0 })
    this.emit({ type: 'log', line: 'stopped' })
  }

  private spawnWorkers() {
    for (let i = 0; i < this.config.threads; i++) {
      const worker = new Worker(`/miner/worker.js?id=${i}`)
      worker.onmessage = (event: MessageEvent<WorkerMessage>) => this.onWorkerMessage(worker, event.data)
      worker.onerror = (event) => this.emit({ type: 'log', line: `worker ${i} error: ${event.message}` })
      this.workers.push(worker)
    }
  }

  private stopWorkers() {
    for (const worker of this.workers) {
      worker.postMessage({ type: 'stop' })
      worker.terminate()
    }
    this.workers = []
    this.rates.clear()
  }

  private startSampler() {
    if (this.sampler) return
    this.sampler = setInterval(() => {
      let total = 0
      for (const rate of this.rates.values()) total += rate
      this.emit({ type: 'hashrate', value: total })
    }, 1000)
  }

  private stopSampler() {
    if (!this.sampler) return
    clearInterval(this.sampler)
    this.sampler = null
  }

  private broadcast(job: StratumJob) {
    const previous = this.currentJob
    if (previous && previous.jobId !== job.jobId) {
      // A clean_jobs notify kills the old job outright; otherwise the pool may
      // still credit a share that was already in flight.
      this.previousJob = job.cleanJobs ? null : previous
    }
    this.currentJob = job
    this.emit({ type: 'job', jobId: job.jobId })
    for (const worker of this.workers) worker.postMessage(toWorkMessage(job))
  }

  /**
   * zpool retargets difficulty mid-job. Workers hold their own copy of the
   * target, so without this push they keep solving for the old one and every
   * share that misses the new target comes back as a low-difficulty reject.
   */
  private applyDifficulty(value: number) {
    this.emit({ type: 'difficulty', value })
    if (this.currentJob) this.currentJob.miningDiff = value
    for (const worker of this.workers) worker.postMessage({ type: 'difficulty', value })
  }

  private onWorkerMessage(worker: Worker, msg: WorkerMessage) {
    if (msg.type === 'ready') {
      if (this.currentJob) worker.postMessage(toWorkMessage(this.currentJob))
      return
    }

    if (msg.type === 'hashrate' && msg.workerId !== undefined) {
      this.rates.set(msg.workerId, msg.hashrate ?? 0)
      return
    }

    if (msg.type === 'share' && msg.data) {
      const { jobId, extraNonce2, ntime, nonce } = msg.data
      const current = this.currentJob
      const stillValid =
        current !== null &&
        (jobId === current.jobId || (this.previousJob !== null && jobId === this.previousJob.jobId))

      // The pool answers a superseded job with [21,"Invalid job id"]. Dropping
      // the share locally costs nothing — it was already worthless — and keeps
      // the reject counter measuring real problems instead of job churn.
      if (!stillValid) {
        this.emit({ type: 'stale' })
        this.emit({
          type: 'log',
          line: `stale share dropped — job ${jobId.slice(0, 8)} already replaced`,
        })
        return
      }

      this.emit({ type: 'log', line: `share found nonce ${nonce}` })
      this.stratum?.submit(jobId, extraNonce2, ntime, nonce)
      return
    }

    if (msg.type === 'error') {
      this.emit({ type: 'log', line: `engine error: ${msg.message}` })
    }
  }
}

function toWorkMessage(job: StratumJob) {
  return {
    type: 'work' as const,
    data: {
      jobId: job.jobId,
      prevhash: job.prevhash,
      coinb1: job.coinb1,
      coinb2: job.coinb2,
      merkleBranch: job.merkleBranch,
      version: job.version,
      nbits: job.nbits,
      ntime: job.ntime,
      extraNonce1: job.extraNonce1,
      extraNonce2Size: job.extraNonce2Size,
      miningDiff: job.miningDiff,
    },
  }
}
