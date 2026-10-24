import { ALGOS, PAYOUT_CURRENCIES, type AlgoId } from './coins'

/**
 * Spot prices for the payout estimate, checked 2026-10-24. Static on purpose:
 * the panel has to render without a network round-trip, and a stale price only
 * shifts the estimate by the same percentage.
 */
export const PAYOUT_PRICE_USD: Record<string, number> = {
  LTC: 56.58,
  DOGE: 0.16,
  DGB: 0.008,
  RVN: 0.012,
}

/** Measured on a mid-range laptop core; used only to project before a session starts. */
export const NOMINAL_HPS_PER_THREAD = 550

export interface PayoutOutlook {
  symbol: string
  threshold: number
  thresholdUsd: number
  dailyUsd: number
  daysToPayout: number
  machinesFor30Days: number
  machinesFor1Day: number
}

export function payoutOutlook(hashrate: number, algoId: AlgoId, symbol: string): PayoutOutlook {
  const algo = ALGOS[algoId]
  const currency = PAYOUT_CURRENCIES.find((c) => c.symbol === symbol) ?? PAYOUT_CURRENCIES[0]
  const price = PAYOUT_PRICE_USD[currency.symbol] ?? 0
  const thresholdUsd = currency.minPayout * price
  const dailyUsd = (hashrate / 1e9) * algo.stats.estimateUsdPerGhs
  const daysToPayout = dailyUsd > 0 ? thresholdUsd / dailyUsd : Number.POSITIVE_INFINITY

  return {
    symbol: currency.symbol,
    threshold: currency.minPayout,
    thresholdUsd,
    dailyUsd,
    daysToPayout,
    machinesFor30Days: dailyUsd > 0 ? thresholdUsd / (dailyUsd * 30) : Number.POSITIVE_INFINITY,
    machinesFor1Day: daysToPayout,
  }
}

export function formatDays(days: number): string {
  if (!Number.isFinite(days)) return '—'
  if (days < 1) return `${(days * 24).toFixed(1)} h`
  if (days < 60) return `${days.toFixed(1)} days`
  if (days < 730) return `${(days / 30.44).toFixed(1)} months`
  return `${Math.round(days / 365.25).toLocaleString('en-US')} years`
}

export function formatMachines(count: number): string {
  if (!Number.isFinite(count)) return '—'
  if (count < 10) return count.toFixed(1)
  return Math.round(count).toLocaleString('en-US')
}
