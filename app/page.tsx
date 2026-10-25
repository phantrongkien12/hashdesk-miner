import { MinerDashboard } from '@/components/miner/miner-dashboard'
import {
  ALGOS,
  DEFAULT_ALGO,
  DEFAULT_PAYOUT,
  DEFAULT_RELAY,
  DEFAULT_WALLET,
  PAYOUT_CURRENCIES,
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

  // Any wss:// endpoint is accepted so a self-hosted relay works without a code
  // change; the built-in list is only the default and the failover order.
  const relayParam = read('relay')
  const relay = relayParam && /^wss?:\/\//i.test(relayParam) ? relayParam : DEFAULT_RELAY

  const payoutParam = read('payout')?.toUpperCase()
  const payout = PAYOUT_CURRENCIES.some((item) => item.symbol === payoutParam)
    ? payoutParam!
    : DEFAULT_PAYOUT

  const threadsParam = Number(read('threads'))
  const threads =
    Number.isFinite(threadsParam) && threadsParam >= 1 ? Math.min(threadsParam, 16) : undefined

  const initial: Partial<EngineConfig> = {
    algo,
    payout,
    wallet: read('wallet') || process.env.MINER_WALLET || DEFAULT_WALLET,
    threads,
    relay,
  }

  const autostartParam = read('autostart')
  const autostart = autostartParam === '1' || autostartParam === 'true'

  const telemetryParam = read('telemetry')
  const telemetry = telemetryParam === '1' || telemetryParam === 'true'

  return <MinerDashboard initial={initial} autostart={autostart} telemetry={telemetry} />
}
