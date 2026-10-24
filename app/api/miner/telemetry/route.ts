import { NextResponse } from 'next/server'
import {
  pushTelemetry,
  readTelemetry,
  resetTelemetry,
  type TelemetryEvent,
  type TelemetrySnapshot,
} from '@/lib/miner/telemetry-store'

export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  const body = (await request.json()) as {
    snapshot?: TelemetrySnapshot
    events?: TelemetryEvent[]
  }
  if (!body.snapshot) {
    return NextResponse.json({ error: 'snapshot required' }, { status: 400 })
  }
  pushTelemetry(body.snapshot, body.events ?? [])
  return NextResponse.json({ ok: true })
}

export async function GET(request: Request) {
  const raw = new URL(request.url).searchParams.get('since')
  const since = Number(raw ?? 0)
  return NextResponse.json(readTelemetry(Number.isFinite(since) ? since : 0))
}

export async function DELETE() {
  resetTelemetry()
  return NextResponse.json({ ok: true })
}
