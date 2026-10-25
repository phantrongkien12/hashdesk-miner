export type AlgoId = 'minotaurx' | 'yescrypt' | 'yespower' | 'power2b'

export interface AlgoStats {
  /**
   * Pool-reported USD per GH/s per day. zpool's `estimate_usd` field is quoted
   * per GH/s, not per MH/s — a browser does well under 1 MH/s, so this number
   * has to be scaled by hashrate / 1e9 to stay honest.
   */
  estimateUsdPerGhs: number
  /** Difficulty the pool hands out on connect. Lower means faster shares. */
  initialDiff: number
  /** Total pool hashrate in H/s. zpool reports kH/s, so its figures are ×1000 here. */
  poolHashrate: number
  workers: number
}

export interface Algo {
  id: AlgoId
  label: string
  host: string
  port: number
  /** Coins the pool can auto-switch between before converting to the payout currency. */
  autoCoins: string[]
  stats: AlgoStats
  recommended?: boolean
}

// Endpoints, ports and stats verified live against zpool.ca.
export const ALGOS: Record<AlgoId, Algo> = {
  minotaurx: {
    id: 'minotaurx',
    label: 'MinotaurX',
    host: 'minotaurx.na.mine.zpool.ca',
    port: 7019,
    autoCoins: ['CAS', 'LCC', 'MAZA'],
    stats: {
      estimateUsdPerGhs: 12.83,
      initialDiff: 0.000008,
      poolHashrate: 4_447_333_000,
      workers: 3224,
    },
    recommended: true,
  },
  yescrypt: {
    id: 'yescrypt',
    label: 'Yescrypt',
    host: 'yescrypt.na.mine.zpool.ca',
    port: 6233,
    autoCoins: ['BSTY', 'XMY'],
    stats: {
      estimateUsdPerGhs: 12.8,
      initialDiff: 0.5,
      poolHashrate: 1_604_480_000,
      workers: 1724,
    },
  },
  yespower: {
    id: 'yespower',
    label: 'Yespower',
    host: 'yespower.na.mine.zpool.ca',
    port: 6234,
    autoCoins: ['VECO'],
    stats: {
      estimateUsdPerGhs: 0.0215,
      initialDiff: 0.1,
      poolHashrate: 27_241_000,
      workers: 210,
    },
  },
  power2b: {
    id: 'power2b',
    label: 'Power2B',
    host: 'power2b.na.mine.zpool.ca',
    port: 6242,
    autoCoins: [],
    stats: {
      estimateUsdPerGhs: 0,
      initialDiff: 0.1,
      poolHashrate: 20_904_000,
      workers: 31,
    },
  },
}

export const ALGO_LIST = Object.values(ALGOS)

export interface PayoutCurrency {
  symbol: string
  name: string
  minPayout: number
}

export const PAYOUT_CURRENCIES: PayoutCurrency[] = [
  { symbol: 'LTC', name: 'Litecoin', minPayout: 0.05 },
  { symbol: 'DOGE', name: 'Dogecoin', minPayout: 5 },
  { symbol: 'DGB', name: 'DigiByte', minPayout: 5 },
  { symbol: 'RVN', name: 'Ravencoin', minPayout: 0.05 },
]

export const DEFAULT_WALLET = 'ltc1qkdfz6awelxenp8lc8v7hr2k8m4xamawmk2sgzg'
export const DEFAULT_ALGO: AlgoId = 'minotaurx'
export const DEFAULT_PAYOUT = 'LTC'

export const RELAYS = [
  { id: 'koyeb', label: 'Relay A (Koyeb)', url: 'wss://technical-dasha-devdev-ccf19728.koyeb.app' },
  { id: 'coderun1', label: 'Relay B (Code.run)', url: 'wss://wss--server--gccv7jh7vmb6.code.run' },
  { id: 'coderun2', label: 'Relay C (Code.run)', url: 'wss://wss--server2--gccv7jh7vmb6.code.run' },
]

export const DEFAULT_RELAY = RELAYS[0].url

/**
 * Each thread is its own Web Worker, so this is also the number of Chrome
 * renderer processes. 64 covers a 64-core box while staying well inside
 * Chrome's process limit; the real constraint is RAM, roughly 40 MB per thread.
 */
export const MAX_THREADS = 64

/**
 * One core is left for the UI and the stratum socket, otherwise the page
 * stutters and share submissions get delayed.
 */
export function recommendedThreads(): number {
  const cores = typeof navigator === 'undefined' ? 4 : navigator.hardwareConcurrency || 4
  return Math.max(1, Math.min(cores - 1, MAX_THREADS))
}

export function dailyUsd(hashrate: number, algo: Algo): number {
  return (hashrate / 1e9) * algo.stats.estimateUsdPerGhs
}

export function formatHashrate(h: number): { value: string; unit: string } {
  if (!Number.isFinite(h) || h <= 0) return { value: '0', unit: 'H/s' }
  if (h >= 1e9) return { value: (h / 1e9).toFixed(2), unit: 'GH/s' }
  if (h >= 1e6) return { value: (h / 1e6).toFixed(2), unit: 'MH/s' }
  if (h >= 1e3) return { value: (h / 1e3).toFixed(2), unit: 'kH/s' }
  return { value: h.toFixed(0), unit: 'H/s' }
}

export function formatDuration(ms: number): string {
  const total = Math.floor(ms / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return [h, m, s].map((n) => String(n).padStart(2, '0')).join(':')
}

export function formatUsd(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '$0'
  if (value < 0.001) return `$${value.toFixed(6)}`
  if (value < 0.01) return `$${value.toFixed(4)}`
  if (value < 1) return `$${value.toFixed(3)}`
  return `$${value.toFixed(2)}`
}

export function formatDiff(diff: number): string {
  if (!Number.isFinite(diff) || diff <= 0) return '0'
  if (diff < 0.001) return diff.toExponential(1)
  return diff.toFixed(diff < 1 ? 3 : 2)
}

export function formatCount(value: number): string {
  return value.toLocaleString('en-US')
}
