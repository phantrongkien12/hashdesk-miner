'use client'

import { useEffect, useRef } from 'react'
import { ALGOS } from '@/lib/miner/coins'
import type { EngineConfig } from '@/lib/miner/engine'
import { useMiner } from '@/hooks/use-miner'
import { ConfigPanel } from './config-panel'
import { HashratePanel } from './hashrate-panel'
import { LogConsole } from './log-console'
import { PayoutPanel } from './payout-panel'
import { StatsGrid } from './stats-grid'

export function MinerDashboard({
  initial,
  autostart = false,
}: {
  initial: Partial<EngineConfig>
  autostart?: boolean
}) {
  const miner = useMiner(initial)
  const algo = ALGOS[miner.config.algo]

  // Headless Chrome cannot click, so ?autostart=1 starts the engine on mount.
  // The effect owns the engine lifecycle rather than firing once, because
  // StrictMode mounts, unmounts, then mounts again in development.
  const startRef = useRef(miner.start)
  startRef.current = miner.start
  const stopRef = useRef(miner.stop)
  stopRef.current = miner.stop

  useEffect(() => {
    if (!autostart) return
    startRef.current()
    return () => stopRef.current()
  }, [autostart])

  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-8 md:px-6 md:py-12">
      <header className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="flex items-center gap-2.5">
            <span className="grid size-7 place-items-center rounded border border-primary/40 bg-primary/10 font-mono text-[13px] font-semibold text-primary">
              H
            </span>
            <h1 className="text-lg font-semibold tracking-tight text-foreground">Hashdesk</h1>
          </div>
          <p className="mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">
            A browser mining console. The hashing engine is WebAssembly, the pool connection is
            stratum over a WebSocket relay, and your payout address never leaves this tab.
          </p>
        </div>
        <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
          {algo.label} · {miner.config.payout} payout
        </p>
      </header>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-4">
          <HashratePanel
            hashrate={miner.hashrate}
            history={miner.history}
            status={miner.status}
            statusDetail={miner.statusDetail}
            algoLabel={algo.label}
            payout={miner.config.payout}
          />
          <StatsGrid
            accepted={miner.accepted}
            rejected={miner.rejected}
            difficulty={miner.difficulty}
            uptime={miner.uptime}
            threads={miner.config.threads}
            jobId={miner.jobId}
          />
          <PayoutPanel
            hashrate={miner.hashrate}
            threads={miner.config.threads}
            algo={miner.config.algo}
            payout={miner.config.payout}
            running={miner.running}
          />
          <LogConsole logs={miner.logs} />
        </div>

        <ConfigPanel
          config={miner.config}
          onChange={miner.setConfig}
          running={miner.running}
          hashrate={miner.hashrate}
          keepAwake={miner.keepAwake}
          onKeepAwakeChange={miner.setKeepAwake}
          onStart={miner.start}
          onStop={miner.stop}
        />
      </div>

      <footer className="mt-8 border-t border-border pt-5 text-[11px] leading-relaxed text-muted-foreground">
        <p>
          Mining on a CPU earns very little and will heat your machine. A browser thread manages
          roughly 0.1–0.3 MH/s, which works out to a fraction of a cent per day — the pool&apos;s
          minimum payout takes a long time to reach. Only run this on hardware you own, and only
          while you choose to.
        </p>
      </footer>
    </main>
  )
}
