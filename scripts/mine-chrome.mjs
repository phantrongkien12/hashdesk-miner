#!/usr/bin/env node
/**
 * Runs the Hashdesk web miner inside headless Chrome on a Linux VPS.
 *
 * The page is opened with ?autostart=1, so no click automation or CDP client is
 * needed: Chrome loads the URL, the app starts the engine on mount, and this
 * script only has to keep the process alive and restart it if it dies.
 */
import { spawn } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { ALGO, PAYOUT, RELAY, WALLET } from './miner-config.mjs'

const CHROME_CANDIDATES = [
  process.env.CHROME_BIN,
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
  '/opt/google/chrome/chrome',
].filter(Boolean)

const args = parseArgs(process.argv.slice(2))

if (args.help) {
  console.log(`Usage: node scripts/mine-chrome.mjs [options]

  --url <url>          App URL to open            (default http://127.0.0.1:3000)
  --wallet <addr>      Payout address             (default: ${WALLET})
  --algo <id>          Algorithm                  (default minotaurx)
  --payout <symbol>    Payout currency            (default LTC)
  --threads <n>        Worker threads             (default: cores - 1, chosen by the page)
  --relay <wss url>    WebSocket relay            (default: the app's built-in default)
  --duration <sec>     Stop after N seconds       (default 0 = run forever)
  --log <path>         Log file                   (default mine-chrome.log)
  --profile <dir>      Chrome user-data-dir       (default .chrome-profile)
  --chrome <path>      Chrome binary              (default: auto-detect)
  --headful            Run with a visible window  (needs Xvfb on a headless VPS)
  --no-restart         Exit when Chrome exits instead of restarting
  --dry-run            Print the command and exit
  --check              Query the pool for this wallet's hashrate and exit
  --help               Show this message
`)
  process.exit(0)
}

if (args.check) {
  await checkPool(args)
  process.exit(0)
}

const chromePath = args.chrome ?? CHROME_CANDIDATES.find((path) => existsSync(path))
if (!chromePath && !args.dryRun) {
  console.error('No Chrome/Chromium binary found. Install one or pass --chrome <path>.')
  console.error('Tried:\n  ' + CHROME_CANDIDATES.join('\n  '))
  process.exit(1)
}

const profileDir = resolve(args.profile)
mkdirSync(profileDir, { recursive: true })

const targetUrl = buildUrl(args)
const logPath = resolve(args.log)
const log = createWriteStream(logPath, { flags: 'a' })

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
  '--metrics-recording-only',
  '--password-store=basic',
  '--use-mock-keychain',
  `--user-data-dir=${profileDir}`,
  targetUrl,
]

if (args.dryRun) {
  console.log(`${chromePath ?? '<chrome>'} ${chromeArgs.map(quote).join(' ')}`)
  process.exit(0)
}

write(`chrome      ${chromePath}`)
write(`url         ${targetUrl}`)
write(`profile     ${profileDir}`)
write(`log         ${logPath}`)
write(`mode        ${args.headful ? 'headful' : 'headless'}${args.restart ? ', auto-restart' : ''}`)

let child = null
let stopping = false
let restarts = 0
let backoff = 5_000
let startedAt = 0

function write(line) {
  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19)
  const text = `[${stamp}] ${line}`
  console.log(text)
  log.write(text + '\n')
}

function launch() {
  startedAt = Date.now()
  child = spawn(chromePath, chromeArgs, { stdio: ['ignore', 'pipe', 'pipe'] })

  child.stdout.on('data', (chunk) => log.write(chunk))
  child.stderr.on('data', (chunk) => log.write(chunk))

  child.on('error', (error) => {
    write(`spawn failed: ${error.message}`)
    scheduleRestart()
  })

  child.on('exit', (code, signal) => {
    child = null
    if (stopping) return
    const uptime = Math.round((Date.now() - startedAt) / 1000)
    write(`chrome exited code=${code} signal=${signal} after ${uptime}s`)
    scheduleRestart()
  })

  write(`chrome started pid=${child.pid}`)
}

function scheduleRestart() {
  if (stopping || !args.restart) {
    shutdown(0)
    return
  }
  // A run that survived a while is a healthy run, so reset the backoff.
  if (Date.now() - startedAt > 300_000) backoff = 5_000
  restarts += 1
  write(`restarting in ${Math.round(backoff / 1000)}s (restart #${restarts})`)
  setTimeout(() => {
    if (!stopping) launch()
  }, backoff)
  backoff = Math.min(backoff * 2, 60_000)
}

function shutdown(code) {
  if (stopping) return
  stopping = true
  write('shutting down')
  if (child) {
    child.kill('SIGTERM')
    setTimeout(() => child?.kill('SIGKILL'), 5_000).unref()
  }
  setTimeout(() => {
    log.end()
    process.exit(code)
  }, 300).unref()
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

launch()

if (args.duration > 0) {
  write(`will stop after ${args.duration}s`)
  setTimeout(() => shutdown(0), args.duration * 1000)
}

function buildUrl(options) {
  const url = new URL(options.url)
  url.searchParams.set('autostart', '1')
  if (options.algo) url.searchParams.set('algo', options.algo)
  if (options.payout) url.searchParams.set('payout', options.payout)
  if (options.wallet) url.searchParams.set('wallet', options.wallet)
  if (options.threads) url.searchParams.set('threads', String(options.threads))
  if (options.relay) url.searchParams.set('relay', options.relay)
  return url.toString()
}

async function checkPool(options) {
  const wallet = options.wallet
  if (!wallet) {
    console.error('--check needs --wallet <address>')
    process.exit(1)
  }
  try {
    const res = await fetch(`https://zpool.ca/api/wallets/${wallet}/hashrate`)
    const body = await res.json()
    const latest = Array.isArray(body?.data) ? body.data[0] : null
    if (!latest) {
      console.log('no hashrate samples yet — the pool has not seen this wallet recently')
      return
    }
    const [timestamp, hashrate] = latest
    console.log(`wallet      ${wallet}`)
    console.log(`hashrate    ${hashrate} H/s`)
    console.log(`sample      ${new Date(timestamp * 1000).toISOString()}`)
  } catch (error) {
    console.error(`pool query failed: ${error.message}`)
    process.exit(1)
  }
}

function parseArgs(argv) {
  const parsed = {
    url: 'http://127.0.0.1:3000',
    algo: ALGO,
    payout: PAYOUT,
    wallet: WALLET,
    threads: null,
    relay: RELAY,
    duration: 0,
    log: 'mine-chrome.log',
    profile: '.chrome-profile',
    chrome: null,
    headful: false,
    restart: true,
    dryRun: false,
    check: false,
    help: false,
  }

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    const next = () => {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith('--')) {
        console.error(`${flag} needs a value`)
        process.exit(1)
      }
      i += 1
      return value
    }

    switch (flag) {
      case '--url': parsed.url = next(); break
      case '--wallet': parsed.wallet = next(); break
      case '--algo': parsed.algo = next(); break
      case '--payout': parsed.payout = next(); break
      case '--threads': parsed.threads = Number(next()); break
      case '--relay': parsed.relay = next(); break
      case '--duration': parsed.duration = Number(next()); break
      case '--log': parsed.log = next(); break
      case '--profile': parsed.profile = next(); break
      case '--chrome': parsed.chrome = next(); break
      case '--headful': parsed.headful = true; break
      case '--no-restart': parsed.restart = false; break
      case '--dry-run': parsed.dryRun = true; break
      case '--check': parsed.check = true; break
      case '--help': case '-h': parsed.help = true; break
      default:
        console.error(`unknown option ${flag} (try --help)`)
        process.exit(1)
    }
  }

  return parsed
}

function quote(value) {
  return /[\s"']/.test(value) ? JSON.stringify(value) : value
}
