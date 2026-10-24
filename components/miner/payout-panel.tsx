import { formatUsd, type AlgoId } from '@/lib/miner/coins'
import {
  NOMINAL_HPS_PER_THREAD,
  formatDays,
  formatMachines,
  payoutOutlook,
} from '@/lib/miner/payout'

interface PayoutPanelProps {
  hashrate: number
  threads: number
  algo: AlgoId
  payout: string
  running: boolean
}

export function PayoutPanel({ hashrate, threads, algo, payout, running }: PayoutPanelProps) {
  const projected = !running || hashrate <= 0
  const effective = projected ? threads * NOMINAL_HPS_PER_THREAD : hashrate
  const outlook = payoutOutlook(effective, algo, payout)

  const rows = [
    {
      label: 'Threshold',
      value: `${outlook.threshold} ${outlook.symbol}`,
      detail: `≈ ${formatUsd(outlook.thresholdUsd)}`,
    },
    {
      label: 'Your rate',
      value: `${formatUsd(outlook.dailyUsd)}/day`,
      detail: projected ? 'projected' : 'live',
    },
    {
      label: 'Time to payout',
      value: formatDays(outlook.daysToPayout),
      detail: 'one machine',
    },
  ]

  return (
    <section className="rounded-lg border border-border bg-card">
      <div className="flex items-center justify-between border-b border-border px-5 py-3">
        <h2 className="text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
          Payout
        </h2>
        <p className="font-mono text-[11px] text-muted-foreground">
          {outlook.symbol} · min {outlook.threshold}
        </p>
      </div>

      <dl className="divide-y divide-border">
        {rows.map((row) => (
          <div key={row.label} className="flex items-baseline justify-between gap-4 px-5 py-3">
            <dt className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
              {row.label}
            </dt>
            <dd className="text-right">
              <span className="font-mono text-sm tabular-nums text-foreground">{row.value}</span>
              <span className="ml-2 font-mono text-[11px] text-muted-foreground">{row.detail}</span>
            </dd>
          </div>
        ))}
      </dl>

      <div className="border-t border-border bg-secondary/40 px-5 py-4">
        <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
          Machines to reach payout
        </p>
        <div className="mt-2.5 flex items-end justify-between gap-4">
          <div>
            <p className="font-mono text-2xl tabular-nums text-primary">
              {formatMachines(outlook.machinesFor30Days)}
            </p>
            <p className="mt-0.5 text-[11px] text-muted-foreground">within 30 days</p>
          </div>
          <div className="text-right">
            <p className="font-mono text-sm tabular-nums text-foreground">
              {formatMachines(outlook.machinesFor1Day)}
            </p>
            <p className="mt-0.5 text-[11px] text-muted-foreground">within 1 day</p>
          </div>
        </div>
      </div>

      <p className="border-t border-border px-5 py-3 text-[11px] leading-relaxed text-muted-foreground">
        Each machine is assumed to run {threads} {threads === 1 ? 'thread' : 'threads'} at{' '}
        {NOMINAL_HPS_PER_THREAD} H/s. Yield scales linearly with hashrate, so doubling the machine
        count halves the wait.
      </p>
    </section>
  )
}
