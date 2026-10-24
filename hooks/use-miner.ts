'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { MinerEngine, type EngineConfig, type EngineEvent } from '@/lib/miner/engine'
import {
  DEFAULT_ALGO,
  DEFAULT_PAYOUT,
  DEFAULT_RELAY,
  DEFAULT_WALLET,
  recommendedThreads,
} from '@/lib/miner/coins'
import type { StratumStatus } from '@/lib/miner/stratum'

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

export function useMiner(initial: Partial<EngineConfig> = {}) {
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
  const [stale, setStale] = useState(0)
  const [difficulty, setDifficulty] = useState(0)
  const [uptime, setUptime] = useState(0)
  const [jobId, setJobId] = useState<string | null>(null)
  const [logs, setLogs] = useState<LogLine[]>([])
  const [keepAwake, setKeepAwake] = useState(true)

  const engineRef = useRef<MinerEngine | null>(null)
  const startedAtRef = useRef(0)
  const logIdRef = useRef(0)
  const wakeLockRef = useRef<WakeLockLike | null>(null)
  const audioRef = useRef<{ ctx: AudioContext; osc: OscillatorNode } | null>(null)

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
          break
        case 'hashrate':
          setHashrate(event.value)
          setHistory((prev) => {
            const next = [...prev, event.value]
            return next.length > HISTORY_POINTS ? next.slice(next.length - HISTORY_POINTS) : next
          })
          break
        case 'difficulty':
          setDifficulty(event.value)
          break
        case 'share':
          if (event.accepted) setAccepted((n) => n + 1)
          else setRejected((n) => n + 1)
          break
        case 'stale':
          setStale((n) => n + 1)
          break
        case 'job':
          setJobId(event.jobId)
          break
        case 'log':
          pushLog(event.line)
          break
      }
    },
    [pushLog],
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
    setStale(0)
    setHistory([])
    setUptime(0)
    startedAtRef.current = Date.now()
    const engine = new MinerEngine(config, handleEvent)
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
  }, [releaseKeepAwake])

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
    stale,
    difficulty,
    uptime,
    jobId,
    logs,
    keepAwake,
    setKeepAwake,
    start,
    stop,
  }
}
