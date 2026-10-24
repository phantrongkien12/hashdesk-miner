#!/usr/bin/env node
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'
import { ALGO, PAYOUT, WALLET } from './miner-config.mjs'

// Mirrors lib/miner/coins.ts. Kept inline so the CLI needs no npm packages.
const ALGOS = {
  minotaurx: { host: 'minotaurx.na.mine.zpool.ca', port: 7019 },
  yescrypt: { host: 'yescrypt.na.mine.zpool.ca', port: 6233 },
  yespower: { host: 'yespower.na.mine.zpool.ca', port: 6234 },
  power2b: { host: 'power2b.na.mine.zpool.ca', port: 6242 },
}

const DEFAULTS = {
  wallet: WALLET,
  payout: PAYOUT,
  algo: ALGO,
  threads: Math.max(1, os.cpus().length - 1),
  duration: 0,
}

const HELP = `
Terminal miner for zpool.ca — same wasm engine as the web app, no browser.

Usage
  node scripts/mine-cli.mjs [options]

Options
  --wallet <address>   Payout address            (default: ${DEFAULTS.wallet})
  --payout <SYMBOL>    Payout currency           (default: ${DEFAULTS.payout})
  --algo <id>          ${Object.keys(ALGOS).join(' | ')}
                                                 (default: ${DEFAULTS.algo})
  --threads <n>        Hashing threads           (default: cores - 1 = ${DEFAULTS.threads})
  --host <host>        Override pool host
  --port <port>        Override pool port
  --duration <sec>     Stop automatically after N seconds (default: run until Ctrl+C)
  --help               Show this message

Examples
  node scripts/mine-cli.mjs
  node scripts/mine-cli.mjs --threads 8 --duration 300
  node scripts/mine-cli.mjs --payout DGB --algo minotaurx
`

function parseArgs(argv) {
  const out = { ...DEFAULTS }
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
    if (key === 'threads' || key === 'port' || key === 'duration') out[key] = Number(value)
    else if (key in out) out[key] = value
    else {
      console.error(`Unknown option ${arg}`)
      process.exit(1)
    }
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
const algo = ALGOS[args.algo]
if (!algo) {
  console.error(`Unknown algo "${args.algo}". Choose one of: ${Object.keys(ALGOS).join(', ')}`)
  process.exit(1)
}
if (!Number.isFinite(args.threads) || args.threads < 1) {
  console.error('--threads must be a positive number')
  process.exit(1)
}

const host = args.host || algo.host
const port = args.port || algo.port
const workerName = args.wallet
const password = `c=${args.payout}`

const workerPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mine-worker.mjs')

const state = {
  difficulty: 0,
  accepted: 0,
  rejected: 0,
  submitted: 0,
  jobId: '',
  startedAt: Date.now(),
  connected: false,
}

const workers = []
const rates = new Map()
const hashedTotals = new Map()

function log(line) {
  const t = new Date().toISOString().slice(11, 19)
  console.log(`[${t}] ${line}`)
}

function formatHashrate(h) {
  if (!Number.isFinite(h) || h <= 0) return '0 H/s'
  if (h >= 1e9) return `${(h / 1e9).toFixed(2)} GH/s`
  if (h >= 1e6) return `${(h / 1e6).toFixed(2)} MH/s`
  if (h >= 1e3) return `${(h / 1e3).toFixed(2)} kH/s`
  return `${h.toFixed(0)} H/s`
}

function totalHashrate() {
  let sum = 0
  for (const rate of rates.values()) sum += rate
  return sum
}

function totalHashed() {
  let sum = 0
  for (const value of hashedTotals.values()) sum += value
  return sum
}

// --- stratum over raw TCP -------------------------------------------------
// The browser needs a WebSocket relay because it cannot open TCP sockets.
// Node can, so this connects straight to the pool.

const socket = net.createConnection({ host, port })
let buffer = ''
let nextId = 1
const pending = new Map()
let extraNonce1 = ''
let extraNonce2Size = 4

function request(method, params) {
  return new Promise((resolve, reject) => {
    if (socket.destroyed) {
      reject(new Error('socket closed'))
      return
    }
    const id = nextId++
    pending.set(id, resolve)
    socket.write(`${JSON.stringify({ id, method, params })}\n`)
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`${method} timed out`))
    }, 20_000)
  })
}

function broadcastWork(job) {
  for (const worker of workers) worker.postMessage({ type: 'work', data: job })
}

function handleMessage(msg) {
  if (typeof msg.id === 'number' && pending.has(msg.id)) {
    const resolve = pending.get(msg.id)
    pending.delete(msg.id)
    resolve(msg)
    return
  }

  if (msg.method === 'mining.set_difficulty') {
    state.difficulty = Number(msg.params?.[0]) || 0
    log(`difficulty ${state.difficulty}`)
    return
  }

  if (msg.method === 'mining.set_extranonce') {
    extraNonce1 = String(msg.params?.[0] ?? extraNonce1)
    extraNonce2Size = Number(msg.params?.[1]) || extraNonce2Size
    log(`extranonce updated ${extraNonce1} (size ${extraNonce2Size})`)
    return
  }

  if (msg.method === 'mining.notify') {
    const p = msg.params
    state.jobId = p[0]
    broadcastWork({
      jobId: p[0],
      prevhash: p[1],
      coinb1: p[2],
      coinb2: p[3],
      merkleBranch: p[4],
      version: p[5],
      nbits: p[6],
      ntime: p[7],
      extraNonce1,
      extraNonce2Size,
      miningDiff: state.difficulty,
    })
  }
}

socket.setEncoding('utf8')
socket.on('data', (chunk) => {
  buffer += chunk
  const lines = buffer.split('\n')
  buffer = lines.pop() ?? ''
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      handleMessage(JSON.parse(trimmed))
    } catch {
      // ignore malformed frames
    }
  }
})

socket.on('error', (err) => {
  log(`socket error: ${err.message}`)
  shutdown(1)
})

socket.on('close', () => {
  if (state.connected) log('pool closed the connection')
  shutdown(0)
})

socket.on('connect', async () => {
  state.connected = true
  log(`connected ${host}:${port}`)
  try {
    const sub = await request('mining.subscribe', ['terminal-miner/1.0'])
    const result = sub.result
    if (!Array.isArray(result)) {
      log(`subscribe rejected: ${JSON.stringify(sub.error)}`)
      shutdown(1)
      return
    }
    extraNonce1 = result[1]
    extraNonce2Size = result[2]
    log(`extranonce1 ${extraNonce1} (size ${extraNonce2Size})`)

    const auth = await request('mining.authorize', [workerName, password])
    if (auth.result !== true) {
      log(`authorize failed: ${JSON.stringify(auth.error)}`)
      log('check the wallet address and payout currency')
      shutdown(1)
      return
    }
    log(`authorized ${workerName} -> ${args.payout}`)
    startWorkers()
  } catch (err) {
    log(`handshake failed: ${err.message}`)
    shutdown(1)
  }
})

// --- workers --------------------------------------------------------------

function startWorkers() {
  for (let i = 0; i < args.threads; i++) {
    const worker = new Worker(workerPath)
    workers.push(worker)

    worker.on('message', (msg) => {
      if (msg.type === 'ready') {
        log(`thread ${i} ready`)
        return
      }
      if (msg.type === 'hashrate') {
        rates.set(i, msg.hashrate)
        hashedTotals.set(i, msg.hashed)
        return
      }
      if (msg.type === 'error') {
        log(`thread ${i} error: ${msg.message}`)
        return
      }
      if (msg.type === 'share') {
        submitShare(msg.data)
      }
    })

    worker.on('error', (err) => log(`thread ${i} crashed: ${err.message}`))
  }
}

function submitShare(data) {
  state.submitted++
  request('mining.submit', [workerName, data.jobId, data.extraNonce2, data.ntime, data.nonce])
    .then((msg) => {
      if (msg.result === true) {
        state.accepted++
        log(`share accepted (${state.accepted}/${state.submitted})`)
      } else {
        state.rejected++
        log(`share rejected: ${JSON.stringify(msg.error)}`)
      }
    })
    .catch((err) => {
      state.rejected++
      log(`share failed: ${err.message}`)
    })
}

// --- reporting ------------------------------------------------------------

const reportTimer = setInterval(() => {
  const uptime = Math.floor((Date.now() - state.startedAt) / 1000)
  const hh = String(Math.floor(uptime / 3600)).padStart(2, '0')
  const mm = String(Math.floor((uptime % 3600) / 60)).padStart(2, '0')
  const ss = String(uptime % 60).padStart(2, '0')
  const rate = totalHashrate()
  console.log(
    `[${hh}:${mm}:${ss}] ${formatHashrate(rate).padStart(10)} | ` +
      `shares ${state.accepted}/${state.submitted} (${state.rejected} rejected) | ` +
      `diff ${state.difficulty} | job ${state.jobId.slice(0, 8)}`,
  )
}, 5000)

if (args.duration > 0) {
  setTimeout(() => {
    log(`duration reached (${args.duration}s), stopping`)
    shutdown(0)
  }, args.duration * 1000)
}

// --- shutdown -------------------------------------------------------------

let shuttingDown = false

async function shutdown(code) {
  if (shuttingDown) return
  shuttingDown = true
  clearInterval(reportTimer)

  for (const worker of workers) worker.postMessage({ type: 'stop' })
  await new Promise((resolve) => setTimeout(resolve, 300))
  for (const worker of workers) await worker.terminate()

  const uptime = Math.floor((Date.now() - state.startedAt) / 1000)
  const hashed = totalHashed()

  console.log('')
  console.log('--- session summary ---')
  console.log(`uptime        ${uptime}s`)
  console.log(`hashes        ${hashed.toLocaleString('en-US')}`)
  console.log(`avg hashrate  ${formatHashrate(uptime > 0 ? hashed / uptime : 0)}`)
  console.log(`shares        ${state.accepted} accepted / ${state.rejected} rejected`)

  try {
    // zpool returns a time series, newest sample first: [timestamp, unpaid, balance]
    const res = await fetch(`https://zpool.ca/api/wallets/${workerName}/balance`)
    const body = await res.json()
    const latest = Array.isArray(body?.data) ? body.data[0] : null
    if (latest) console.log(`pool balance  ${latest[2]} ${args.payout}`)
  } catch {
    // balance is a nicety, not a requirement
  }

  if (!socket.destroyed) socket.destroy()
  process.exit(code)
}

process.on('SIGINT', () => {
  log('stopping')
  shutdown(0)
})
process.on('SIGTERM', () => shutdown(0))

console.log('')
console.log(`algo      ${args.algo} (${host}:${port})`)
console.log(`wallet    ${workerName}`)
console.log(`payout    ${args.payout}`)
console.log(`threads   ${args.threads}`)
console.log('')
console.log('Note: this is CPU wasm hashing. Expect roughly 0.5 kH/s per thread,')
console.log('which is far below the pool payout threshold. Ctrl+C to stop.')
console.log('')
