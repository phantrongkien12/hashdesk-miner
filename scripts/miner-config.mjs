// Single source of truth for the payout address used by every CLI entry point.
// Override without editing code: MINER_WALLET=ltc1... node scripts/mine-tui.mjs
export const WALLET = process.env.MINER_WALLET || 'ltc1qkdfz6awelxenp8lc8v7hr2k8m4xamawmk2sgzg'

export const PAYOUT = process.env.MINER_PAYOUT || 'LTC'

export const ALGO = process.env.MINER_ALGO || 'minotaurx'

export const RELAY = process.env.MINER_RELAY || null
