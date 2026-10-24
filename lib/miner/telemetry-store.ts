import type { StratumStatus } from './stratum'

export type TelemetryKind =
  | 'log'
  | 'share'
  | 'stale'
  | 'job'
  | 'difficulty'
  | 'status'
  | 'hashrate'

export interface TelemetryEvent {
  seq: number
  at: number
  kind: TelemetryKind
  text: string
  accepted?: boolean
  value?: number
}

export interface TelemetrySnapshot {
  updatedAt: number
  status: StratumStatus
  statusDetail?: string
  hashrate: number
  accepted: number
  rejected: number
  stale: number
  difficulty: number
  jobId: string | null
  uptime: number
  threads: number
  algo: string
  payout: string
  wallet: string
  relay: string
  paused: boolean
}

export interface TelemetryCommand {
  id: number
  action: 'pause' | 'resume' | 'stop'
}

const MAX_EVENTS = 400

// Module scope is per server process, which is exactly the lifetime a local
// terminal session needs. Nothing here is persisted or shared across instances.
const state = {
  seq: 0,
  events: [] as TelemetryEvent[],
  snapshot: null as TelemetrySnapshot | null,
  command: null as TelemetryCommand | null,
  commandId: 0,
}

export function pushTelemetry(snapshot: TelemetrySnapshot, events: TelemetryEvent[]) {
  state.snapshot = snapshot
  for (const event of events) {
    state.seq = Math.max(state.seq, event.seq)
    state.events.push(event)
  }
  if (state.events.length > MAX_EVENTS) {
    state.events = state.events.slice(state.events.length - MAX_EVENTS)
  }
}

export function readTelemetry(since: number) {
  return {
    snapshot: state.snapshot,
    seq: state.seq,
    events: state.events.filter((event) => event.seq > since),
  }
}

export function queueCommand(action: TelemetryCommand['action']) {
  state.commandId += 1
  state.command = { id: state.commandId, action }
  return state.command
}

export function takeCommand() {
  const command = state.command
  state.command = null
  return command
}

export function resetTelemetry() {
  state.seq = 0
  state.events = []
  state.snapshot = null
  state.command = null
}
