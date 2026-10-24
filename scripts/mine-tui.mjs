#!/usr/bin/env node
/**
 * xmrig-style terminal front-end for the browser miner.
 *
 * Chrome does the hashing (so the pool sees a real browser fingerprint), and
 * this process renders the session the way xmrig does: a startup banner, tagged
 * timestamped log lines, and a live speed bar pinned to the bottom of the
 * terminal. It talks to the app over the local telemetry API.
 */
import { execFileSync, spawn } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync } from 'node:fs'
import os from 'node:os'
import { resolve } from 'node:path'
import { ALGO, PAYOUT, RELAY, WALLET } from './miner-config.mjs'

// Mirrors lib/miner/coins.ts so the TUI can print the pool without a build step.
const ALGOS = {
  minotaurx: { host: 'minotaurx.na.mine.zpool.ca', port: 7019 },
  yescrypt: { host: 'yescrypt.na.mine.zpool.ca', port: 6233 },
  yespower: { host: 'yespower.na.mine.zpool.ca', port: 6234 },
  power2b: { host: 'power2b.na.mine.zpool.ca', port: 6242 },
}

const CHROME_CANDIDATES = [
  process.env.CHROME_BIN,
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
  '/opt/google/chrome/chrome',
].filter(Boolean)

const DEFAULTS = {
  url: 'http://127.0.0.1:3000',
  wallet: WALLET,
  payout: PAYOUT,
  algo: ALGO,
  threads: Math.max(1, os.cpus().length - 1),
  relay: RELAY,
  profile: '.chrome-profile',
  chrome: null,
  headful: false,
  attach: false,
  log: null,
}

const HELP = `
xmrig-style terminal miner for zpool.ca, hashing inside headless Chrome.

Usage
  node scripts/mine-tui.mjs [options]

Options
  --url <url>          App URL                    (default: ${DEFAULTS.url})
  --wallet <address>   Payout address             (default: ${DEFAULTS.wallet})
  --payout <SYMBOL>    Payout currency            (default: ${DEFAULTS.payout})
  --algo <id>          ${Object.keys(ALGOS).join(' | ')}
  --threads <n>        Hashing threads            (default: cores - 1 = ${DEFAULTS.threads})
  --relay <wss url>    WebSocket relay            (default: the app's built-in default)
  --chrome <path>      Chrome binary              (default: auto-detect)
  --profile <dir>      Chrome user-data-dir       (default: ${DEFAULTS.profile})
  --headful            Visible window (needs Xvfb on a headless VPS)
  --attach             Do not launch Chrome, only render an existing session
  --log <path>         Also append log lines to a file
  --help               Show this message

Commands (while running)
  h  hashrate      p  pause        r  resume
  c  connection    s  results      q  quit

Examples
  node scripts/mine-tui.mjs
  node scripts/mine-tui.mjs --threads 8 --algo minotaurx
  node scripts/mine-tui.mjs --attach --url http://127.0.0.1:3000
`

function parseArgs(argv) {
  const out = { ...DEFAULTS }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') {
      console.log(HELP)
      process.exit(0)
    }
    if (arg === '--headful') {
      out.headful = true
      continue
    }
    if (arg === '--attach') {
      out.attach = true
      continue
    }
    const key = arg.replace(/^--/, '')
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) {
      console.error(`Missing value for ${arg}`)
      process.exit(1)
    }
    i += 1
    if (key === 'threads') out.threads = Number(value)
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

const baseUrl = args.url.replace(/\/$/, '')
const pool = `${algo.host}:${algo.port}`
const isTTY = Boolean(process.stdout.isTTY)
const logStream = args.log ? createWriteStream(resolve(args.log), { flags: 'a' }) : null

// --- xmrig formatting -----------------------------------------------------

function stamp(date = new Date()) {
  const pad = (n, width = 2) => String(n).padStart(width, '0')
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.` +
    pad(date.getMilliseconds(), 3)
  )
}

function logLine(tag, message) {
  return `[${stamp()}]  ${tag.padEnd(9)}${message}`
}

let statusDrawn = false

function writeLog(tag, message) {
  const text = logLine(tag, message)
  if (isTTY && statusDrawn) process.stdout.write('\r\x1b[2K')
  process.stdout.write(`${text}\n`)
  statusDrawn = false
  logStream?.write(`${text}\n`)
  if (isTTY) drawStatus()
}

function drawStatus() {
  if (!isTTY) return
  process.stdout.write(`\r\x1b[2K${speedLine()}`)
  statusDrawn = true
}

function fmtRate(value) {
  if (value === null || !Number.isFinite(value)) return 'n/a'
  return value.toFixed(1)
}

function fmtDiff(raw) {
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) return 'n/a'
  if (value >= 1) return value.toFixed(0)
  return value.toFixed(8).replace(/0+$/, '').replace(/\.$/, '')
}

function fmtUptime(ms) {
  const total = Math.floor(ms / 1000)
  const h = String(Math.floor(total / 3600)).padStart(2, '0')
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, '0')
  const s = String(total % 60).padStart(2, '0')
  return `${h}:${m}:${s}`
}

function tagFor(text) {
  if (/worker|thread|wasm|cpu|hash/i.test(text)) return 'cpu'
  if (/pool|socket|connect|authoriz|stratum|relay|difficulty/i.test(text)) return 'net'
  return 'miner'
}

// --- hashrate windows -----------------------------------------------------

const samples = []

function trimSamples() {
  const cutoff = Date.now() - 15 * 60 * 1000
  while (samples.length > 0 && samples[0].at < cutoff) samples.shift()
}

function windowAvg(windowMs) {
  const now = Date.now()
  const inWindow = samples.filter((sample) => now - sample.at <= windowMs)
  if (inWindow.length < 2) return null
  const span = inWindow[inWindow.length - 1].at - inWindow[0].at
  // xmrig reports n/a until the window is actually covered.
  if (span < windowMs * 0.9) return null
  const sum = inWindow.reduce((total, sample) => total + sample.value, 0)
  return sum / inWindow.length
}

function maxRate() {
  if (samples.length === 0) return null
  return samples.reduce((best, sample) => Math.max(best, sample.value), 0)
}

function speedText() {
  return (
    `speed 10s/60s/15m ${fmtRate(windowAvg(10_000))} ${fmtRate(windowAvg(60_000))} ` +
    `${fmtRate(windowAvg(900_000))} H/s max ${fmtRate(maxRate())} H/s`
  )
}

function speedLine() {
  return logLine('miner', speedText())
}

// --- banner ---------------------------------------------------------------

function chromeVersion() {
  const path = args.chrome ?? CHROME_CANDIDATES.find((candidate) => existsSync(candidate))
  if (!path) return 'chrome/unknown'
  try {
    const raw = execFileSync(path, ['--version'], { encoding: 'utf8', timeout: 5000 }).trim()
    return raw.replace(/\s+/g, '/').toLowerCase()
  } catch {
    return 'chrome/unknown'
  }
}

function printBanner() {
  const cpu = os.cpus()[0]?.model?.trim() ?? 'unknown'
  const cores = os.cpus().length
  const totalGb = os.totalmem() / 1024 ** 3
  const usedGb = totalGb - os.freemem() / 1024 ** 3
  const pct = Math.round((usedGb / totalGb) * 100)

  const rows = [
    ['ABOUT', `Hashdesk/1.0.0 node/${process.versions.node}`],
    ['LIBS', `wasm/engine-core ${chromeVersion()}`],
    ['HUGE PAGES', 'unavailable'],
    ['1GB PAGES', 'unavailable'],
    ['CPU', `${cpu} (1) ${cores}C/${cores}T`],
    ['MEMORY', `${usedGb.toFixed(1)}/${totalGb.toFixed(1)} GB (${pct}%)`],
    ['DONATE', '0%'],
    ['POOL #1', `${pool} algo ${args.algo}`],
    ['COMMANDS', 'hashrate, pause, resume, results, connection'],
  ]

  for (const [label, value] of rows) {
    process.stdout.write(` * ${label.padEnd(13)}${value}\n`)
  }
}

// --- session state --------------------------------------------------------

let snapshot = null
let since = 0
let accepted = 0
let rejected = 0
let warned = false
let chrome = null
let stopping = false

function handleEvent(event) {
  switch (event.kind) {
    case 'status': {
      const text = event.text ?? ''
      if (text.startsWith('connecting')) writeLog('net', `use pool ${pool}`)
      else if (text.startsWith('authorizing')) writeLog('net', `authorized ${args.wallet} -> ${args.payout}`)
      else if (text.startsWith('mining')) writeLog('net', `new job from ${pool}`)
      else writeLog('net', text)
      break
    }
    case 'job':
      writeLog(
        'miner',
        `new job from ${pool} diff ${fmtDiff(snapshot?.difficulty)} algo ${args.algo}`,
      )
      break
    case 'difficulty':
      writeLog('net', `difficulty set to ${fmtDiff(event.value)}`)
      break
    case 'share': {
      if (event.accepted) accepted += 1
      else rejected += 1
      const verdict = event.accepted ? 'accepted' : 'rejected'
      writeLog('cpu', `${verdict} (${accepted}/${rejected}) diff ${fmtDiff(snapshot?.difficulty)}`)
      break
    }
    case 'stale':
      writeLog('cpu', 'stale share dropped (job replaced)')
      break
    case 'hashrate':
      samples.push({ at: event.at ?? Date.now(), value: event.value ?? 0 })
      trimSamples()
      break
    case 'log':
      writeLog(tagFor(event.text ?? ''), event.text ?? '')
      break
  }
}

async function poll() {
  try {
    const res = await fetch(`${baseUrl}/api/miner/telemetry?since=${since}`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const body = await res.json()
    if (body.snapshot) snapshot = body.snapshot
    for (const event of body.events ?? []) {
      since = Math.max(since, event.seq)
      handleEvent(event)
    }
    if (isTTY) drawStatus()
  } catch (error) {
    if (!warned) {
      warned = true
      writeLog('net', `telemetry unavailable at ${baseUrl} (${error.message})`)
      writeLog('net', 'start the app first: npx next start -p 3000')
    }
  }
}

async function sendCommand(action) {
  try {
    await fetch(`${baseUrl}/api/miner/command`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action }),
    })
  } catch (error) {
    writeLog('net', `command failed: ${error.message}`)
  }
}

// --- commands -------------------------------------------------------------

function printHashrate() {
  writeLog('cpu', `hashrate ${speedText()}`)
  writeLog('cpu', `threads ${snapshot?.threads ?? args.threads}/${args.threads} (${args.threads}) 100%`)
}

function printConnection() {
  writeLog('net', `pool ${pool} algo ${args.algo}`)
  writeLog('net', `wallet ${args.wallet} payout ${args.payout}`)
  writeLog(
    'net',
    `status ${snapshot?.status ?? 'unknown'}${snapshot?.paused ? ' (paused)' : ''} ` +
      `uptime ${fmtUptime(snapshot?.uptime ?? 0)}`,
  )
}

function printResults() {
  writeLog('cpu', `accepted ${accepted}/${rejected} diff ${fmtDiff(snapshot?.difficulty)}`)
  writeLog('cpu', `job ${snapshot?.jobId ? snapshot.jobId.slice(0, 8) : 'n/a'}`)
}

function setupKeys() {
  if (!process.stdin.isTTY) return
  process.stdin.setRawMode(true)
  process.stdin.resume()
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (key) => {
    switch (key) {
      case '\u0003':
      case 'q':
        shutdown(0)
        break
      case 'h':
        printHashrate()
        break
      case 'p':
        void sendCommand('pause')
        break
      case 'r':
        void sendCommand('resume')
        break
      case 'c':
        printConnection()
        break
      case 's':
        printResults()
        break
      default:
        break
    }
  })
}

// --- chrome ---------------------------------------------------------------

function launchChrome() {
  const chromePath = args.chrome ?? CHROME_CANDIDATES.find((candidate) => existsSync(candidate))
  if (!chromePath) {
    writeLog('config', 'no Chrome/Chromium binary found, pass --chrome <path>')
    return false
  }

  const profileDir = resolve(args.profile)
  mkdirSync(profileDir, { recursive: true })

  const url = new URL(baseUrl)
  url.searchParams.set('autostart', '1')
  url.searchParams.set('telemetry', '1')
  url.searchParams.set('algo', args.algo)
  url.searchParams.set('payout', args.payout)
  url.searchParams.set('wallet', args.wallet)
  url.searchParams.set('threads', String(args.threads))
  if (args.relay) url.searchParams.set('relay', args.relay)

  const chromeArgs = [
    args.headful ? '--start-maximized' : '--headless=new',
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    // Without these Chrome throttles timers and workers in a backgrounded or
    // occluded window, which silently drops hashrate to near zero.
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-features=CalculateNativeWinOcclusion,IntensiveWakeUpThrottling,BackForwardCache',
    '--autoplay-policy=no-user-gesture-required',
    '--mute-audio',
    '--window-size=1280,900',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-sync',
    '--disable-component-update',
    '--password-store=basic',
    '--use-mock-keychain',
    `--user-data-dir=${profileDir}`,
    url.toString(),
  ]

  chrome = spawn(chromePath, chromeArgs, { stdio: ['ignore', 'ignore', 'ignore'] })
  chrome.on('error', (error) => writeLog('config', `chrome failed: ${error.message}`))
  chrome.on('exit', (code) => {
    if (stopping) return
    writeLog('config', `chrome exited (code ${code})`)
    shutdown(1)
  })

  writeLog('config', `chrome started pid=${chrome.pid} ${args.headful ? 'headful' : 'headless'}`)
  return true
}

// --- lifecycle ------------------------------------------------------------

async function shutdown(code) {
  if (stopping) return
  stopping = true

  writeLog('signal', 'stopping, waiting for threads')
  if (chrome) {
    chrome.kill('SIGTERM')
    setTimeout(() => chrome?.kill('SIGKILL'), 3000).unref()
  }

  if (isTTY && statusDrawn) process.stdout.write('\r\x1b[2K')
  process.stdout.write('\n')
  process.stdout.write('--- session summary ---\n')
  process.stdout.write(`uptime        ${fmtUptime(snapshot?.uptime ?? 0)}\n`)
  process.stdout.write(`hashrate max  ${fmtRate(maxRate())} H/s\n`)
  process.stdout.write(`shares        ${accepted} accepted / ${rejected} rejected\n`)
  process.stdout.write(`difficulty    ${fmtDiff(snapshot?.difficulty)}\n`)
  process.stdout.write('\n')

  logStream?.end()
  setTimeout(() => process.exit(code), 200).unref()
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

// --- main -----------------------------------------------------------------

printBanner()

try {
  const probe = await fetch(`${baseUrl}/api/miner/telemetry?since=0`)
  if (!probe.ok) throw new Error(`HTTP ${probe.status}`)
} catch (error) {
  writeLog('config', `cannot reach ${baseUrl} (${error.message})`)
  writeLog('config', 'start the app first: npx next start -p 3000')
  process.exit(1)
}

writeLog('config', `loaded ${baseUrl} algo ${args.algo} threads ${args.threads}`)
writeLog('config', `wallet ${args.wallet} payout ${args.payout}`)

if (!args.attach && !launchChrome()) {
  process.exit(1)
}

setupKeys()

const pollTimer = setInterval(() => void poll(), 1000)
void poll()

// Without a TTY there is no status bar, so the speed line is logged instead.
const speedTimer = isTTY ? null : setInterval(() => writeLog('miner', speedText()), 60_000)

process.on('exit', () => {
  clearInterval(pollTimer)
  if (speedTimer) clearInterval(speedTimer)
})
