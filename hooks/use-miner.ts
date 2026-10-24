'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { MinerEngine, type EngineConfig, type EngineEvent } from '@/lib/miner/engine'
import { DEFAULT_ALGO, DEFAULT_PAYOUT, DEFAULT_RELAY, DEFAULT_WALLET } from '@/lib/miner/coins'
import type { StratumStatus } from '@/lib/miner/stratum'

export interface LogLine {
  id: number
  time: string
  text: string
}

const HISTORY_POINTS = 60
const MAX_LOG_LINES = 120

export function useMiner(initial: Partial<EngineConfig> = {}) {
  const [config, setConfig] = useState<EngineConfig>({
    algo: initial.algo ?? DEFAULT_ALGO,
    payout: initial.payout ?? DEFAULT_PAYOUT,
    wallet: initial.wallet ?? DEFAULT_WALLET,
    threads: initial.threads ?? 2,
    relay: initial.relay ?? DEFAULT_RELAY,
  })

  const [status, setStatus] = useState<StratumStatus>('idle')
  const [statusDetail, setStatusDetail] = useState<string | undefined>()
  const [hashrate, setHashrate] = useState(0)
  const [history, setHistory] = useState<number[]>([])
  const [accepted, setAccepted] = useState(0)
  const [rejected, setRejected] = useState(0)
  const [difficulty, setDifficulty] = useState(0)
  const [uptime, setUptime] = useState(0)
  const [jobId, setJobId] = useState<string | null>(null)
  const [logs, setLogs] = useState<LogLine[]>([])

  const engineRef = useRef<MinerEngine | null>(null)
  const startedAtRef = useRef(0)
  const logIdRef = useRef(0)

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

  const start = useCallback(() => {
    if (engineRef.current) return
    if (!config.wallet.trim()) {
      pushLog('wallet address is required')
      return
    }
    setAccepted(0)
    setRejected(0)
    setHistory([])
    setUptime(0)
    startedAtRef.current = Date.now()
    const engine = new MinerEngine(config, handleEvent)
    engineRef.current = engine
    engine.start()
  }, [config, handleEvent, pushLog])

  const stop = useCallback(() => {
    engineRef.current?.stop()
    engineRef.current = null
    setStatus('idle')
    setStatusDetail(undefined)
    setHashrate(0)
    setJobId(null)
  }, [])

  useEffect(() => {
    if (status === 'idle') return
    const timer = setInterval(() => setUptime(Date.now() - startedAtRef.current), 1000)
    return () => clearInterval(timer)
  }, [status])

  useEffect(() => {
    return () => {
      engineRef.current?.stop()
      engineRef.current = null
    }
  }, [])

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
    difficulty,
    uptime,
    jobId,
    logs,
    start,
    stop,
  }
}
