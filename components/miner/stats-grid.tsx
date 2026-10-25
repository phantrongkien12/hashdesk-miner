import { formatDuration } from '@/lib/miner/coins'

interface StatsGridProps {
  accepted: number
  rejected: number
  lost: number
  stale: number
  difficulty: number
  uptime: number
  threads: number
  jobId: string | null
}

export function StatsGrid({
  accepted,
  rejected,
  lost,
  stale,
  difficulty,
  uptime,
  threads,
  jobId,
}: StatsGridProps) {
  const total = accepted + rejected
  const acceptRate = total > 0 ? Math.round((accepted / total) * 100) : null

  const items = [
    { label: 'Accepted', value: String(accepted), tone: 'text-primary' },
    { label: 'Rejected', value: String(rejected), tone: rejected > 0 ? 'text-destructive' : '' },
    { label: 'Accept rate', value: acceptRate === null ? '—' : `${acceptRate}%`, tone: '' },
    { label: 'Difficulty', value: difficulty > 0 ? String(difficulty) : '—', tone: '' },
    { label: 'Uptime', value: formatDuration(uptime), tone: '' },
    { label: 'Threads', value: String(threads), tone: '' },
  ]

  return (
    <section className="rounded-lg border border-border bg-card">
      <div className="flex items-center justify-between border-b border-border px-5 py-3">
        <h2 className="text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
          Session
        </h2>
        <p className="font-mono text-[11px] text-muted-foreground">
          job {jobId ? jobId.slice(0, 8) : '—'}
          {lost > 0 ? ` · ${lost} lost` : ''}
          {stale > 0 ? ` · ${stale} stale dropped` : ''}
        </p>
      </div>
      <dl className="grid grid-cols-2 gap-px bg-border sm:grid-cols-3">
        {items.map((item) => (
          <div key={item.label} className="bg-card px-5 py-4">
            <dt className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
              {item.label}
            </dt>
            <dd className={`mt-1.5 font-mono text-xl tabular-nums ${item.tone || 'text-foreground'}`}>
              {item.value}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  )
}
