import { formatHashrate } from '@/lib/miner/coins'
import type { StratumStatus } from '@/lib/miner/stratum'
import { Sparkline } from './sparkline'

const STATUS_LABEL: Record<StratumStatus, string> = {
  idle: 'Idle',
  connecting: 'Connecting',
  authorizing: 'Authorizing',
  mining: 'Mining',
  error: 'Error',
}

const STATUS_TONE: Record<StratumStatus, string> = {
  idle: 'bg-muted text-muted-foreground',
  connecting: 'bg-accent/15 text-accent',
  authorizing: 'bg-accent/15 text-accent',
  mining: 'bg-primary/15 text-primary',
  error: 'bg-destructive/15 text-destructive',
}

interface HashratePanelProps {
  hashrate: number
  history: number[]
  status: StratumStatus
  statusDetail?: string
  algoLabel: string
  payout: string
}

export function HashratePanel({
  hashrate,
  history,
  status,
  statusDetail,
  algoLabel,
  payout,
}: HashratePanelProps) {
  const { value, unit } = formatHashrate(hashrate)

  return (
    <section className="rounded-lg border border-border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-3">
        <div className="flex items-center gap-2.5">
          <span
            className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium uppercase tracking-wider ${STATUS_TONE[status]}`}
            role="status"
            aria-live="polite"
          >
            <span
              className={`size-1.5 rounded-full bg-current ${status === 'mining' ? 'animate-pulse' : ''}`}
            />
            {STATUS_LABEL[status]}
          </span>
          {statusDetail && <span className="text-xs text-muted-foreground">{statusDetail}</span>}
        </div>
        <p className="font-mono text-xs text-muted-foreground">
          {algoLabel} <span className="text-border">/</span> {payout}
        </p>
      </div>

      <div className="px-5 pt-6">
        <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
          Total hashrate
        </p>
        <div className="mt-2 flex items-baseline gap-2">
          <span className="font-mono text-6xl font-medium tabular-nums leading-none tracking-tight text-foreground md:text-7xl">
            {value}
          </span>
          <span className="font-mono text-lg text-muted-foreground">{unit}</span>
        </div>
      </div>

      <div className="mt-5 h-28 w-full">
        <Sparkline data={history} className="h-full w-full" />
      </div>
    </section>
  )
}
