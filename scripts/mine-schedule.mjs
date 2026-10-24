#!/usr/bin/env node
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ALGO, PAYOUT, WALLET } from './miner-config.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.join(HERE, 'mine-cli.mjs')

const DEFAULTS = {
  window: 300,
  gap: 60,
  cycles: 0,
  log: path.join(process.cwd(), 'mine-schedule.log'),
  threads: Math.max(1, os.cpus().length - 1),
  payout: PAYOUT,
  algo: ALGO,
  wallet: WALLET,
}

const HELP = `
Runs the terminal miner on a repeating schedule: mine for a window, rest for a
gap, repeat. Each cycle is a fresh pool connection, so a dropped socket never
stops the schedule.

Usage
  node scripts/mine-schedule.mjs [options]

Options
  --window <sec>     Mine for N seconds per cycle   (default: ${DEFAULTS.window})
  --gap <sec>        Rest for N seconds between     (default: ${DEFAULTS.gap})
  --cycles <n>       Stop after N cycles, 0 = forever (default: ${DEFAULTS.cycles})
  --log <path>       Append output to this file     (default: ./mine-schedule.log)
  --threads <n>      Hashing threads                (default: cores - 1 = ${DEFAULTS.threads})
  --payout <SYMBOL>  Payout currency                (default: ${DEFAULTS.payout})
  --algo <id>        minotaurx | yescrypt | yespower | power2b
  --wallet <address> Payout address                (default: ${DEFAULTS.wallet})
  --help             Show this message

Examples
  node scripts/mine-schedule.mjs --window 600 --gap 120
  node scripts/mine-schedule.mjs --window 60 --gap 30 --cycles 3 --threads 2
`

function parseArgs(argv) {
  const out = { ...DEFAULTS }
  const numeric = new Set(['window', 'gap', 'cycles', 'threads'])
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') {
      console.log(HELP)
      process.exit(0)
    }
    const key = arg.replace(/^--/, '')
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) {
      console.error(`Missing value for ${arg}`)
      process.exit(1)
    }
    i++
    if (numeric.has(key)) out[key] = Number(value)
    else if (key in out) out[key] = value
    else {
      console.error(`Unknown option ${arg}`)
      process.exit(1)
    }
  }
  return out
}

const args = parseArgs(process.argv.slice(2))

if (!Number.isFinite(args.window) || args.window < 10) {
  console.error('--window must be at least 10 seconds')
  process.exit(1)
}
if (!Number.isFinite(args.gap) || args.gap < 0) {
  console.error('--gap must be zero or more seconds')
  process.exit(1)
}

const logStream = fs.createWriteStream(args.log, { flags: 'a' })

function log(line) {
  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19)
  const text = `[${stamp}] ${line}`
  console.log(text)
  logStream.write(`${text}\n`)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

let child = null
let stopping = false

function stopChild(signal = 'SIGTERM') {
  if (child && !child.killed) child.kill(signal)
}

function runCycle(index) {
  return new Promise((resolve) => {
    const cliArgs = [
      CLI,
      '--threads',
      String(args.threads),
      '--payout',
      args.payout,
      '--algo',
      args.algo,
      '--duration',
      String(args.window),
    ]
    if (args.wallet) cliArgs.push('--wallet', args.wallet)

    log(`cycle ${index} start — ${args.window}s on ${args.algo}, ${args.threads} threads`)
    child = spawn(process.execPath, cliArgs, { stdio: ['ignore', 'pipe', 'pipe'] })

    const forward = (chunk) => {
      for (const line of chunk.toString().split('\n')) {
        if (line.trim()) logStream.write(`  ${line}\n`)
      }
    }
    child.stdout.on('data', forward)
    child.stderr.on('data', forward)

    child.on('close', (code) => {
      child = null
      log(`cycle ${index} end — exit ${code}`)
      resolve(code)
    })
  })
}

async function main() {
  log(
    `schedule start — window ${args.window}s, gap ${args.gap}s, ` +
      `cycles ${args.cycles === 0 ? 'forever' : args.cycles}, log ${args.log}`,
  )

  let failures = 0
  for (let cycle = 1; args.cycles === 0 || cycle <= args.cycles; cycle++) {
    if (stopping) break

    const code = await runCycle(cycle)
    failures = code === 0 ? 0 : failures + 1

    if (failures >= 3) {
      log('three consecutive failed cycles, stopping the schedule')
      break
    }

    const isLast = args.cycles !== 0 && cycle === args.cycles
    if (isLast || stopping) break

    log(`resting ${args.gap}s`)
    await sleep(args.gap * 1000)
  }

  log('schedule stopped')
  logStream.end()
  process.exit(0)
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (stopping) return
    stopping = true
    log(`${signal} received, stopping after the current cycle`)
    stopChild()
  })
}

main()
