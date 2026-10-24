import { NextResponse } from 'next/server'
import { queueCommand, takeCommand, type TelemetryCommand } from '@/lib/miner/telemetry-store'

export const dynamic = 'force-dynamic'

const ACTIONS: TelemetryCommand['action'][] = ['pause', 'resume', 'stop']

export async function POST(request: Request) {
  const body = (await request.json()) as { action?: string }
  const action = body.action as TelemetryCommand['action']
  if (!ACTIONS.includes(action)) {
    return NextResponse.json({ error: 'unknown action' }, { status: 400 })
  }
  return NextResponse.json(queueCommand(action))
}

export async function GET() {
  return NextResponse.json({ command: takeCommand() })
}
