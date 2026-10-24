import { MinerDashboard } from '@/components/miner/miner-dashboard'
import {
  ALGOS,
  DEFAULT_ALGO,
  DEFAULT_PAYOUT,
  DEFAULT_RELAY,
  DEFAULT_WALLET,
  PAYOUT_CURRENCIES,
  RELAYS,
  type AlgoId,
} from '@/lib/miner/coins'
import type { EngineConfig } from '@/lib/miner/engine'

type SearchParams = Promise<Record<string, string | string[] | undefined>>

export default async function Page({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams
  const read = (key: string) => {
    const value = params[key]
    return Array.isArray(value) ? value[0] : value
  }

  const algoParam = read('algo')
  const algo: AlgoId = algoParam && algoParam in ALGOS ? (algoParam as AlgoId) : DEFAULT_ALGO

  const relayParam = read('relay')
  const relay = RELAYS.some((item) => item.url === relayParam) ? relayParam! : DEFAULT_RELAY

  const payoutParam = read('payout')?.toUpperCase()
  const payout = PAYOUT_CURRENCIES.some((item) => item.symbol === payoutParam)
    ? payoutParam!
    : DEFAULT_PAYOUT

  const threadsParam = Number(read('threads'))
  const threads = Number.isFinite(threadsParam) && threadsParam >= 1 ? Math.min(threadsParam, 16) : 2

  const initial: Partial<EngineConfig> = {
    algo,
    payout,
    wallet: read('wallet') || DEFAULT_WALLET,
    threads,
    relay,
  }

  return <MinerDashboard initial={initial} />
}
