'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { MinerEngine, type EngineConfig, type EngineEvent } from '@/lib/miner/engine'
import {
  DEFAULT_ALGO,
  DEFAULT_PAYOUT,
  DEFAULT_RELAY,
  DEFAULT_WALLET,
  RELAYS,
  recommendedThreads,
} from '@/lib/miner/coins'
import type { StratumStatus } from '@/lib/miner/stratum'
import type { TelemetryEvent, TelemetrySnapshot } from '@/lib/miner/telemetry-store'

export interface LogLine {
  id: number
  time: string
  text: string
}

const HISTORY_POINTS = 60
const MAX_LOG_LINES = 120

type WakeLockLike = { release: () => Promise<void> }
type WakeLockNavigator = Navigator & {
  wakeLock?: { request: (type: 'screen') => Promise<WakeLockLike> }
}

export function useMiner(
  initial: Partial<EngineConfig> = {},
  options: { telemetry?: boolean } = {},
) {
  const telemetry = options.telemetry ?? false
  const [config, setConfig] = useState<EngineConfig>({
    algo: initial.algo ?? DEFAULT_ALGO,
    payout: initial.payout ?? DEFAULT_PAYOUT,
    wallet: initial.wallet ?? DEFAULT_WALLET,
    threads: initial.threads ?? recommendedThreads(),
    relay: initial.relay ?? DEFAULT_RELAY,
  })

  const [status, setStatus] = useState<StratumStatus>('idle')
  const [statusDetail, setStatusDetail] = useState<string | undefined>()
  const [hashrate, setHashrate] = useState(0)
  const [history, setHistory] = useState<number[]>([])
  const [accepted, setAccepted] = useState(0)
  const [rejected, setRejected] = useState(0)
  const [lost, setLost] = useState(0)
  const [stale, setStale] = useState(0)
  const [difficulty, setDifficulty] = useState(0)
  const [uptime, setUptime] = useState(0)
  const [jobId, setJobId] = useState<string | null>(null)
  const [logs, setLogs] = useState<LogLine[]>([])
  const [keepAwake, setKeepAwake] = useState(true)
  const [paused, setPaused] = useState(false)

  const engineRef = useRef<MinerEngine | null>(null)
  const startedAtRef = useRef(0)
  const logIdRef = useRef(0)
  const wakeLockRef = useRef<WakeLockLike | null>(null)
  const audioRef = useRef<{ ctx: AudioContext; osc: OscillatorNode } | null>(null)
  const telemetryRef = useRef(telemetry)
  telemetryRef.current = telemetry
  const queueRef = useRef<TelemetryEvent[]>([])
  const seqRef = useRef(0)
  const snapshotRef = useRef<TelemetrySnapshot | null>(null)

  const enqueue = useCallback(
    (kind: TelemetryEvent['kind'], text: string, extra?: Partial<TelemetryEvent>) => {
      if (!telemetryRef.current) return
      seqRef.current += 1
      queueRef.current.push({ seq: seqRef.current, at: Date.now(), kind, text, ...extra })
    },
    [],
  )

  const pushLog = useCallback((text: string) => {
    const time = new Date().toLocaleTimeString('en-GB', { hour12: false })
    setLogs((prev) => {
      const next = [...prev, { id: logIdRef.current++, time, text }]
      return next.length > MAX_LOG_LINES ? next.slice(next.length - MAX_LOG_LINES) : next
    })
  }, [])

  const handleEvent = useCallback(
    (event: EngineEvent) => {
      switch (event.type) {
        case 'status':
          setStatus(event.status)
          setStatusDetail(event.detail)
          enqueue('status', event.detail ? `${event.status} ${event.detail}` : event.status)
          break
        case 'hashrate':
          setHashrate(event.value)
          setHistory((prev) => {
            const next = [...prev, event.value]
            return next.length > HISTORY_POINTS ? next.slice(next.length - HISTORY_POINTS) : next
          })
          enqueue('hashrate', String(event.value), { value: event.value })
          break
        case 'difficulty':
          setDifficulty(event.value)
          enqueue('difficulty', String(event.value), { value: event.value })
          break
        case 'share':
          if (event.accepted) setAccepted((n) => n + 1)
          else setRejected((n) => n + 1)
          enqueue('share', event.detail, { accepted: event.accepted })
          break
        case 'lost':
          setLost((n) => n + 1)
          enqueue('lost', event.detail)
          break
        case 'stale':
          setStale((n) => n + 1)
          enqueue('stale', 'stale share dropped')
          break
        case 'job':
          setJobId(event.jobId)
          enqueue('job', event.jobId)
          break
        case 'log':
          pushLog(event.line)
          enqueue('log', event.line)
          break
      }
    },
    [pushLog, enqueue],
  )

  const releaseKeepAwake = useCallback(() => {
    wakeLockRef.current?.release().catch(() => {})
    wakeLockRef.current = null
    if (audioRef.current) {
      audioRef.current.osc.stop()
      audioRef.current.ctx.close().catch(() => {})
      audioRef.current = null
    }
  }, [])

  const acquireKeepAwake = useCallback(async () => {
    const nav = navigator as WakeLockNavigator
    try {
      if (nav.wakeLock && !wakeLockRef.current) {
        wakeLockRef.current = await nav.wakeLock.request('screen')
      }
    } catch {
      // Wake lock is best-effort: unsupported, denied, or already held.
    }

    try {
      if (!audioRef.current) {
        const ctx = new AudioContext()
        const osc = ctx.createOscillator()
        const gain = ctx.createGain()
        // A silent, inaudible tone keeps the tab classified as "playing audio",
        // which is what stops Chrome from throttling timers in a hidden tab.
        gain.gain.value = 0.0001
        osc.connect(gain).connect(ctx.destination)
        osc.start()
        audioRef.current = { ctx, osc }
      }
      await audioRef.current.ctx.resume()
    } catch {
      // Audio is best-effort too; mining still works, just throttled when hidden.
    }
  }, [])

  const start = useCallback(() => {
    if (engineRef.current) return
    if (!config.wallet.trim()) {
      pushLog('wallet address is required')
      return
    }
    setAccepted(0)
    setRejected(0)
    setLost(0)
    setStale(0)
    setPaused(false)
    setHistory([])
    setUptime(0)
    startedAtRef.current = Date.now()
    // The chosen relay goes first; the rest stay as failover targets.
    const relays = [config.relay, ...RELAYS.map((r) => r.url).filter((url) => url !== config.relay)]
    const engine = new MinerEngine({ ...config, relays }, handleEvent)
    engineRef.current = engine
    engine.start()
    if (keepAwake) void acquireKeepAwake()
  }, [config, handleEvent, pushLog, keepAwake, acquireKeepAwake])

  const stop = useCallback(() => {
    engineRef.current?.stop()
    engineRef.current = null
    releaseKeepAwake()
    setStatus('idle')
    setStatusDetail(undefined)
    setHashrate(0)
    setJobId(null)
    setPaused(false)
  }, [releaseKeepAwake])

  const pause = useCallback(() => {
    engineRef.current?.pause()
    setPaused(true)
  }, [])

  const resume = useCallback(() => {
    engineRef.current?.resume()
    setPaused(false)
  }, [])

  useEffect(() => {
    if (status === 'idle') return
    const timer = setInterval(() => setUptime(Date.now() - startedAtRef.current), 1000)
    return () => clearInterval(timer)
  }, [status])

  // Browsers drop the wake lock whenever the tab is hidden, so it has to be
  // re-requested on the way back.
  useEffect(() => {
    if (!keepAwake) {
      releaseKeepAwake()
      return
    }
    const onVisible = () => {
      if (document.visibilityState === 'visible' && engineRef.current) void acquireKeepAwake()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [keepAwake, acquireKeepAwake, releaseKeepAwake])

  useEffect(() => {
    return () => {
      engineRef.current?.stop()
      engineRef.current = null
      releaseKeepAwake()
    }
  }, [releaseKeepAwake])

  snapshotRef.current = {
    updatedAt: Date.now(),
    status,
    statusDetail,
    hashrate,
    accepted,
    rejected,
    lost,
    stale,
    difficulty,
    jobId,
    uptime,
    threads: config.threads,
    algo: config.algo,
    payout: config.payout,
    wallet: config.wallet,
    relay: config.relay,
    paused,
  }

  const pauseRef = useRef(pause)
  pauseRef.current = pause
  const resumeRef = useRef(resume)
  resumeRef.current = resume
  const stopRef = useRef(stop)
  stopRef.current = stop

  useEffect(() => {
    if (!telemetry) return
    const flush = () => {
      const snapshot = snapshotRef.current
      if (!snapshot) return
      const events = queueRef.current.splice(0)
      void fetch('/api/miner/telemetry', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ snapshot, events }),
      }).catch(() => {})
    }
    const timer = setInterval(flush, 1000)
    return () => clearInterval(timer)
  }, [telemetry])

  useEffect(() => {
    if (!telemetry) return
    const poll = async () => {
      try {
        const res = await fetch('/api/miner/command')
        const body = (await res.json()) as { command?: { action: string } | null }
        const action = body.command?.action
        if (action === 'pause') pauseRef.current()
        else if (action === 'resume') resumeRef.current()
        else if (action === 'stop') stopRef.current()
      } catch {
        // The terminal is the only consumer, so a missed poll costs nothing.
      }
    }
    const timer = setInterval(poll, 1500)
    return () => clearInterval(timer)
  }, [telemetry])

  const running = status === 'connecting' || status === 'authorizing' || status === 'mining'

  return {
    config,
    setConfig,
    status,
    statusDetail,
    running,
    hashrate,
    history,
    accepted,
    rejected,
    lost,
    stale,
    difficulty,
    uptime,
    jobId,
    logs,
    keepAwake,
    setKeepAwake,
    paused,
    start,
    stop,
    pause,
    resume,
  }
}
