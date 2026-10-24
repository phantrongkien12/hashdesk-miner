'use client'

import { useEffect, useState } from 'react'
import { Check, Copy, Link2, Play, Square } from 'lucide-react'
import {
  ALGOS,
  ALGO_LIST,
  MAX_THREADS,
  PAYOUT_CURRENCIES,
  RELAYS,
  dailyUsd,
  formatCount,
  formatDiff,
  formatHashrate,
  formatUsd,
  recommendedThreads,
  type AlgoId,
} from '@/lib/miner/coins'
import type { EngineConfig } from '@/lib/miner/engine'

interface ConfigPanelProps {
  config: EngineConfig
  onChange: (next: EngineConfig) => void
  running: boolean
  hashrate: number
  keepAwake: boolean
  onKeepAwakeChange: (value: boolean) => void
  onStart: () => void
  onStop: () => void
}

const fieldClass =
  'w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground/60 focus:border-primary focus:ring-2 focus:ring-primary/25'

const labelClass = 'text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground'

export function ConfigPanel({
  config,
  onChange,
  running,
  hashrate,
  keepAwake,
  onKeepAwakeChange,
  onStart,
  onStop,
}: ConfigPanelProps) {
  const [cores, setCores] = useState(4)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    const detected = navigator.hardwareConcurrency
    if (detected) setCores(detected)
  }, [])

  const maxThreads = Math.max(1, Math.min(cores, MAX_THREADS))
  const autoThreads = recommendedThreads()
  const algo = ALGOS[config.algo]
  const payout = PAYOUT_CURRENCIES.find((item) => item.symbol === config.payout) ?? PAYOUT_CURRENCIES[0]
  const pool = formatHashrate(algo.stats.poolHashrate)
  const perDay = dailyUsd(hashrate, algo)

  const update = (patch: Partial<EngineConfig>) => onChange({ ...config, ...patch })

  const copyLink = async () => {
    const params = new URLSearchParams({
      algo: config.algo,
      payout: config.payout,
      wallet: config.wallet,
      threads: String(config.threads),
      relay: config.relay,
    })
    try {
      await navigator.clipboard.writeText(`${window.location.origin}${window.location.pathname}?${params}`)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch {
      setCopied(false)
    }
  }

  return (
    <section className="rounded-lg border border-border bg-card">
      <div className="border-b border-border px-5 py-3">
        <h2 className="text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
          Configuration
        </h2>
      </div>

      <div className="space-y-5 px-5 py-5">
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <label htmlFor="algo" className={labelClass}>
              Algorithm
            </label>
            {algo.recommended && (
              <span className="rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-primary">
                Best for browser
              </span>
            )}
          </div>
          <select
            id="algo"
            value={config.algo}
            onChange={(event) => update({ algo: event.target.value as AlgoId })}
            disabled={running}
            className={fieldClass}
          >
            {ALGO_LIST.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
                {item.recommended ? ' — recommended' : ''}
              </option>
            ))}
          </select>
          <p className="font-mono text-[11px] text-muted-foreground">
            {algo.host}:{algo.port}
          </p>

          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-md border border-border bg-background/40 px-3 py-3 font-mono text-[11px]">
            <div>
              <dt className="text-muted-foreground">Profit</dt>
              <dd className="text-foreground">
                {formatUsd(algo.stats.estimateUsdPerGhs)}
                <span className="text-muted-foreground">/GH/s/day</span>
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Start diff</dt>
              <dd className="text-foreground">{formatDiff(algo.stats.initialDiff)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Pool</dt>
              <dd className="text-foreground">
                {pool.value} {pool.unit}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Workers</dt>
              <dd className="text-foreground">{formatCount(algo.stats.workers)}</dd>
            </div>
          </dl>

          <p className="font-mono text-[11px] leading-relaxed text-muted-foreground">
            Auto-switch:{' '}
            {algo.autoCoins.length ? algo.autoCoins.join(' · ') : 'none — direct mining only'}
          </p>
        </div>

        <div className="space-y-2">
          <label htmlFor="payout" className={labelClass}>
            Payout currency
          </label>
          <select
            id="payout"
            value={config.payout}
            onChange={(event) => update({ payout: event.target.value })}
            disabled={running}
            className={fieldClass}
          >
            {PAYOUT_CURRENCIES.map((item) => (
              <option key={item.symbol} value={item.symbol}>
                {item.symbol} — {item.name}
              </option>
            ))}
          </select>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            The pool mines the most profitable coin on this algorithm and converts it to{' '}
            {payout.symbol}. Minimum payout {payout.minPayout} {payout.symbol}, sent every other day
            once the balance clears the threshold.
          </p>
        </div>

        <div className="space-y-2">
          <label htmlFor="wallet" className={labelClass}>
            Payout address
          </label>
          <input
            id="wallet"
            value={config.wallet}
            onChange={(event) => update({ wallet: event.target.value.trim() })}
            disabled={running}
            spellCheck={false}
            autoComplete="off"
            className={fieldClass}
            placeholder="your wallet address"
          />
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            Rewards go straight to this address. It must match the payout currency. Nothing is held
            by this site.
          </p>
        </div>

        <div className="space-y-2">
          <div className="flex items-baseline justify-between gap-2">
            <label htmlFor="threads" className={labelClass}>
              Threads
            </label>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => update({ threads: autoThreads })}
                disabled={running || config.threads === autoThreads}
                className="rounded border border-border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground disabled:opacity-40"
              >
                Auto
              </button>
              <span className="font-mono text-sm tabular-nums text-foreground">{config.threads}</span>
            </div>
          </div>
          <input
            id="threads"
            type="range"
            min={1}
            max={maxThreads}
            step={1}
            value={config.threads}
            onChange={(event) => update({ threads: Number(event.target.value) })}
            disabled={running}
            className="w-full accent-[var(--primary)]"
          />
          <p className="font-mono text-[11px] text-muted-foreground">
            {cores} logical cores · auto uses {autoThreads}
          </p>
        </div>

        <div className="space-y-2">
          <label htmlFor="relay" className={labelClass}>
            WebSocket relay
          </label>
          <select
            id="relay"
            value={config.relay}
            onChange={(event) => update({ relay: event.target.value })}
            disabled={running}
            className={fieldClass}
          >
            {RELAYS.map((relay) => (
              <option key={relay.id} value={relay.url}>
                {relay.label}
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-start justify-between gap-3 rounded-md border border-border bg-background/40 px-3 py-2.5">
          <div className="space-y-0.5">
            <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
              Keep awake
            </p>
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              Holds a screen wake lock and a silent audio stream so a hidden tab keeps hashing.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={keepAwake}
            aria-label="Keep mining while the tab is hidden"
            onClick={() => onKeepAwakeChange(!keepAwake)}
            className={`mt-0.5 inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors ${
              keepAwake ? 'border-primary bg-primary/25' : 'border-border bg-secondary'
            }`}
          >
            <span
              className={`size-3.5 rounded-full transition-transform ${
                keepAwake ? 'translate-x-[18px] bg-primary' : 'translate-x-[2px] bg-muted-foreground'
              }`}
            />
          </button>
        </div>

        <div className="rounded-md border border-border bg-background/40 px-3 py-2.5 font-mono text-[11px] text-muted-foreground">
          {hashrate > 0 ? (
            <>
              <span className="text-foreground">{formatUsd(perDay)}</span> / day at{' '}
              {formatHashrate(hashrate).value} {formatHashrate(hashrate).unit}
            </>
          ) : (
            'Start mining to estimate daily earnings'
          )}
        </div>

        <div className="flex gap-2 pt-1">
          <button
            type="button"
            onClick={running ? onStop : onStart}
            className={`inline-flex flex-1 items-center justify-center gap-2 rounded-md px-4 py-2.5 text-sm font-medium transition-colors ${
              running
                ? 'bg-secondary text-secondary-foreground hover:bg-secondary/80'
                : 'bg-primary text-primary-foreground hover:bg-primary/90'
            }`}
          >
            {running ? <Square className="size-4" /> : <Play className="size-4" />}
            {running ? 'Stop mining' : 'Start mining'}
          </button>
          <button
            type="button"
            onClick={copyLink}
            title="Copy a link with this configuration"
            aria-label="Copy configuration link"
            className="inline-flex items-center justify-center rounded-md border border-border px-3 text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
          >
            {copied ? <Check className="size-4 text-primary" /> : <Copy className="size-4" />}
          </button>
        </div>

        <p className="flex items-start gap-2 border-t border-border pt-4 text-[11px] leading-relaxed text-muted-foreground">
          <Link2 className="mt-0.5 size-3.5 shrink-0" />
          <span>
            Mining runs entirely in your browser. Keep this tab visible, or leave Keep awake on so
            the browser does not throttle a hidden tab.
          </span>
        </p>
      </div>
    </section>
  )
}
