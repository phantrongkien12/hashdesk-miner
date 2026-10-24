'use client'

import { useEffect, useRef } from 'react'
import type { LogLine } from '@/hooks/use-miner'

export function LogConsole({ logs }: { logs: LogLine[] }) {
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [logs])

  return (
    <section className="rounded-lg border border-border bg-card">
      <div className="flex items-center justify-between border-b border-border px-5 py-3">
        <h2 className="text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
          Console
        </h2>
        <p className="font-mono text-[11px] text-muted-foreground">{logs.length} lines</p>
      </div>
      <div
        className="h-56 overflow-y-auto px-5 py-3 font-mono text-[12px] leading-relaxed"
        role="log"
        aria-live="polite"
        aria-label="Mining console output"
      >
        {logs.length === 0 ? (
          <p className="text-muted-foreground">
            Waiting for a session. Set a payout address and press start.
          </p>
        ) : (
          logs.map((line) => (
            <p key={line.id} className="flex gap-3">
              <span className="shrink-0 text-muted-foreground/60">{line.time}</span>
              <span className="break-all text-foreground/85">{line.text}</span>
            </p>
          ))
        )}
        <div ref={endRef} />
      </div>
    </section>
  )
}
