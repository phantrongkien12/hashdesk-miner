export type AlgoId = 'minotaurx' | 'yescrypt' | 'yespower' | 'power2b'

export interface AlgoStats {
  /** Pool-reported USD per MH/s per day. */
  estimateUsdPerMhs: number
  /** Difficulty the pool hands out on connect. Lower means faster shares. */
  initialDiff: number
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
      estimateUsdPerMhs: 12.83,
      initialDiff: 0.000008,
      poolHashrate: 4_447_333,
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
      estimateUsdPerMhs: 12.8,
      initialDiff: 0.5,
      poolHashrate: 1_604_480,
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
      estimateUsdPerMhs: 0.0215,
      initialDiff: 0.1,
      poolHashrate: 27_241,
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
      estimateUsdPerMhs: 0,
      initialDiff: 0.1,
      poolHashrate: 20_904,
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
