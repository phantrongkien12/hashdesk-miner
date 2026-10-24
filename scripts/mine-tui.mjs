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
import { createWriteStream, existsSync, mkdirSync, readdirSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import { join, resolve } from 'node:path'
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
  '/usr/lib/chromium/chromium',
  '/usr/lib/chromium-browser/chromium-browser',
].filter(Boolean)

const CHROME_INSTALL_HINT =
  'install without root: npx @puppeteer/browsers install chrome@stable'

const DEFAULTS = {
  url: null,
  port: 3100,
  wallet: WALLET,
  payout: PAYOUT,
  algo: ALGO,
  threads: Math.max(1, os.cpus().length - 1),
  relay: RELAY,
  profile: '.chrome-profile',
  chrome: null,
  headful: false,
  attach: false,
  serve: false,
  doctor: false,
  noColor: false,
  log: null,
}

/**
 * Chrome is rarely where a distro package puts it on a VPS: Puppeteer and
 * Playwright download into a cache dir, and snap/flatpak use their own paths.
 */
function findChrome() {
  if (args.chrome) return existsSync(args.chrome) ? args.chrome : null

  const direct = CHROME_CANDIDATES.find((candidate) => existsSync(candidate))
  if (direct) return direct

  // @sparticuz/chromium unpacks a self-contained build here. It bundles every
  // library Chrome needs except nss/nspr, which scripts/fix-chrome-libs.sh
  // supplies, so it is the only option on a box with no package manager.
  if (existsSync('/tmp/chromium')) return '/tmp/chromium'

  // @puppeteer/browsers installs into ./chrome relative to the working
  // directory, so the project dir has to be searched too.
  for (const root of [
    resolve('chrome'),
    resolve('.cache', 'puppeteer'),
    join(os.homedir(), '.cache', 'puppeteer'),
    join(os.homedir(), '.cache', 'ms-playwright'),
    join(os.homedir(), 'chrome'),
  ]) {
    const found = findChromeIn(root)
    if (found) return found
  }

  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    try {
      const path = execFileSync('which', [name], {
        encoding: 'utf8',
        timeout: 3000,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim()
      if (path) return path
    } catch {
      // Not on PATH, keep looking.
    }
  }

  return null
}

function findChromeIn(root) {
  if (!existsSync(root)) return null
  try {
    const entries = readdirSync(root, { recursive: true, withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isFile()) continue
      if (entry.name !== 'chrome' && entry.name !== 'chromium') continue
      const path = join(entry.parentPath ?? entry.path, entry.name)
      if (existsSync(path)) return path
    }
  } catch {
    // Unreadable cache dir, treat as absent.
  }
  return null
}

const HELP = `
xmrig-style terminal miner for zpool.ca, hashing inside headless Chrome.

Usage
  node scripts/mine-tui.mjs [options]

Options
  --serve              Start the web app too, on a free port (one command)
  --port <n>           Port for --serve / the app URL  (default: ${DEFAULTS.port})
  --url <url>          Full app URL, overrides --port
  --wallet <address>   Payout address             (default: ${DEFAULTS.wallet})
  --payout <SYMBOL>    Payout currency            (default: ${DEFAULTS.payout})
  --algo <id>          ${Object.keys(ALGOS).join(' | ')}
  --threads <n>        Hashing threads            (default: cores - 1 = ${DEFAULTS.threads})
  --relay <wss url>    WebSocket relay            (default: the app's built-in default)
  --chrome <path>      Chrome binary              (default: auto-detect)
  --profile <dir>      Chrome user-data-dir       (default: ${DEFAULTS.profile})
  --headful            Visible window (needs Xvfb on a headless VPS)
  --attach             Do not launch Chrome, only render an existing session
  --doctor             Check Chrome and the app, then exit
  --no-color           Plain output (also honours NO_COLOR)
  --log <path>         Also append log lines to a file
  --help               Show this message

Commands (while running)
  h  hashrate      p  pause        r  resume
  c  connection    s  results      q  quit

Examples
  node scripts/mine-tui.mjs --serve
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
    if (arg === '--serve') {
      out.serve = true
      continue
    }
    if (arg === '--doctor') {
      out.doctor = true
      continue
    }
    if (arg === '--no-color') {
      out.noColor = true
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
    else if (key === 'port') out.port = Number(value)
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

// Resolved in main() once --serve has picked a port.
let baseUrl = (args.url ?? `http://127.0.0.1:${args.port}`).replace(/\/$/, '')
const pool = `${algo.host}:${algo.port}`
const isTTY = Boolean(process.stdout.isTTY)
const logStream = args.log ? createWriteStream(resolve(args.log), { flags: 'a' }) : null

// --- xmrig palette --------------------------------------------------------

// xmrig's console colours: a grey timestamp, one colour per log tag, and bold
// green/red on the share verdict. Colour is dropped when the output is piped,
// when NO_COLOR is set, or with --no-color, so log files stay plain text.
const useColor =
  isTTY && !args.noColor && !process.env.NO_COLOR && process.env.TERM !== 'dumb'

const C = {
  reset: '\x1b[0m',
  gray: '\x1b[90m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  boldRed: '\x1b[1;31m',
  boldGreen: '\x1b[1;32m',
  boldWhite: '\x1b[1;37m',
}

const TAG_COLOR = {
  net: C.cyan,
  cpu: C.green,
  miner: C.magenta,
  config: C.white,
  signal: C.yellow,
  error: C.red,
}

function paint(code, text) {
  return useColor ? `${code}${text}${C.reset}` : text
}

/** A fragment that is plain in the log file and coloured on the terminal. */
function mark(text, color) {
  return { plain: text, colored: paint(color, text) }
}

// --- xmrig formatting -----------------------------------------------------

function stamp(date = new Date()) {
  const pad = (n, width = 2) => String(n).padStart(width, '0')
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.` +
    pad(date.getMilliseconds(), 3)
  )
}

function logLine(tag, parts) {
  const list = Array.isArray(parts) ? parts : [parts]
  const body = (key) =>
    list.map((part) => (typeof part === 'string' ? part : part[key])).join('')

  const time = stamp()
  const plain = `[${time}]  ${tag.padEnd(9)}${body('plain')}`
  if (!useColor) return { plain, colored: plain }

  const tagColor = TAG_COLOR[tag] ?? C.white
  return {
    plain,
    colored: `${C.gray}[${time}]${C.reset}  ${paint(tagColor, tag.padEnd(9))}${body('colored')}`,
  }
}

let statusDrawn = false

function writeLog(tag, parts) {
  const { plain, colored } = logLine(tag, parts)
  if (isTTY && statusDrawn) process.stdout.write('\r\x1b[2K')
  process.stdout.write(`${colored}\n`)
  statusDrawn = false
  logStream?.write(`${plain}\n`)
  if (isTTY) drawStatus()
}

function drawStatus() {
  // --doctor prints a report and exits, so a live speed line would only
  // interleave with it.
  if (!isTTY || args.doctor) return
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
  const rate = (value) => mark(fmtRate(value), C.green)
  return logLine('miner', [
    'speed 10s/60s/15m ',
    rate(windowAvg(10_000)),
    ' ',
    rate(windowAvg(60_000)),
    ' ',
    rate(windowAvg(900_000)),
    ' H/s max ',
    mark(fmtRate(maxRate()), C.yellow),
    ' H/s',
  ]).colored
}

// --- banner ---------------------------------------------------------------

/**
 * A Chrome binary that exists but cannot start is the common case on a VPS:
 * the download succeeds, then the loader fails on missing system libraries.
 * Reporting "unknown" hides that, so the failure is classified here.
 */
function diagnoseChrome() {
  const path = findChrome()
  if (!path) return { path: null, state: 'missing', version: null, missing: [] }

  try {
    const raw = execFileSync(path, ['--version'], {
      encoding: 'utf8',
      timeout: 8000,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: chromeEnv(),
    }).trim()
    return { path, state: 'ok', version: raw.replace(/\s+/g, '/').toLowerCase(), missing: [] }
  } catch (error) {
    const text = `${error.stderr ?? ''}${error.stdout ?? ''}${error.message ?? ''}`
    const missing = [...new Set(text.match(/lib[\w.+-]+\.so[\w.]*/g) ?? [])]
    return { path, state: 'broken', version: null, missing }
  }
}

/**
 * scripts/fix-chrome-libs.sh unpacks the missing packages into ./libs. Chrome
 * only sees them through LD_LIBRARY_PATH, so it is set for every child process
 * here rather than asking the user to export it in their shell.
 */
function localLibPath() {
  const dirs = [
    resolve('libs', 'usr', 'lib', 'x86_64-linux-gnu', 'nss'),
    resolve('libs', 'usr', 'lib', 'x86_64-linux-gnu'),
    resolve('libs', 'usr', 'lib', 'aarch64-linux-gnu'),
    resolve('libs', 'usr', 'lib'),
    resolve('libs', 'lib', 'x86_64-linux-gnu'),
  ].filter((dir) => existsSync(dir))

  if (dirs.length === 0) return null
  return [...dirs, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':')
}

function chromeEnv() {
  const libPath = localLibPath()
  if (!libPath) return process.env

  const env = { ...process.env, LD_LIBRARY_PATH: libPath }

  // Without a fontconfig config Chrome aborts in SkFontMgr_FontConfigInterface.
  const fontsConf = resolve('libs', 'etc', 'fonts')
  if (existsSync(fontsConf)) env.FONTCONFIG_PATH = fontsConf

  return env
}

function chromeVersion() {
  const diagnosis = diagnoseChrome()
  if (diagnosis.state === 'ok') return diagnosis.version
  if (diagnosis.state === 'broken') return 'chrome/missing-libs'
  return 'chrome/unknown'
}

const CHROME_APT_PACKAGES = [
  'libnss3',
  'libnspr4',
  'libatk1.0-0',
  'libatk-bridge2.0-0',
  'libatspi2.0-0',
  'libcups2',
  'libdrm2',
  'libgbm1',
  'libxkbcommon0',
  'libxcomposite1',
  'libxdamage1',
  'libxfixes3',
  'libxrandr2',
  'libpango-1.0-0',
  'libcairo2',
  'libasound2',
  'libx11-6',
  'libxcb1',
  'libxext6',
]

function printChromeReport() {
  const diagnosis = diagnoseChrome()

  if (diagnosis.state === 'missing') {
    writeLog('config', 'chrome not found')
    writeLog('config', 'install without root:')
    writeLog('config', '  npx @puppeteer/browsers install chrome@stable')
    return false
  }

  if (diagnosis.state === 'ok') {
    writeLog('config', `chrome ok: ${diagnosis.path}`)
    writeLog('config', `version ${diagnosis.version}`)
    return true
  }

  writeLog('config', `chrome found but cannot start: ${diagnosis.path}`)
  if (diagnosis.missing.length > 0) {
    writeLog('config', `missing libraries: ${diagnosis.missing.join(' ')}`)
  }
  writeLog('config', 'the binary needs system packages that are not installed.')
  writeLog('config', 'with root:')
  writeLog('config', `  sudo apt install -y ${CHROME_APT_PACKAGES.join(' ')}`)
  writeLog('config', 'without root, ask the box admin to run that, or extract the')
  writeLog('config', 'packages into a local dir and point LD_LIBRARY_PATH at it:')
  writeLog('config', '  mkdir -p ~/libs && cd ~/libs')
  writeLog('config', `  apt-get download ${CHROME_APT_PACKAGES.slice(0, 4).join(' ')} ...`)
  writeLog('config', '  for f in *.deb; do dpkg-deb -x "$f" .; done')
  writeLog('config', '  export LD_LIBRARY_PATH=$HOME/libs/usr/lib/x86_64-linux-gnu:$LD_LIBRARY_PATH')
  return false
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
    process.stdout.write(
      ` ${paint(C.gray, '*')} ${paint(C.white, label.padEnd(13))}${value}\n`,
    )
  }
}

// --- session state --------------------------------------------------------

let snapshot = null
let since = 0
let accepted = 0
let rejected = 0
let warned = false
let chrome = null
let server = null
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
      const verdict = event.accepted
        ? mark('accepted', C.boldGreen)
        : mark('rejected', C.boldRed)
      writeLog('cpu', [
        verdict,
        ` (${accepted}/${rejected}) diff ${fmtDiff(snapshot?.difficulty)}`,
      ])
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
      writeLog('net', 'the app stopped responding, restart it or use --serve')
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
  const diagnosis = diagnoseChrome()
  if (diagnosis.state !== 'ok') {
    printChromeReport()
    return false
  }
  const chromePath = diagnosis.path

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

  chrome = spawn(chromePath, chromeArgs, {
    stdio: ['ignore', 'ignore', 'ignore'],
    env: chromeEnv(),
  })
  chrome.on('error', (error) => writeLog('config', `chrome failed: ${error.message}`))
  chrome.on('exit', (code) => {
    if (stopping) return
    writeLog('config', `chrome exited (code ${code})`)
    shutdown(1)
  })

  writeLog('config', `chrome started pid=${chrome.pid} ${args.headful ? 'headful' : 'headless'}`)
  return true
}

// --- app server -----------------------------------------------------------

async function portIsFree(port) {
  return new Promise((done) => {
    const probe = net.createServer()
    probe.once('error', () => done(false))
    probe.once('listening', () => probe.close(() => done(true)))
    probe.listen(port, '127.0.0.1')
  })
}

async function pickPort(preferred) {
  for (let port = preferred; port < preferred + 20; port += 1) {
    if (await portIsFree(port)) return port
  }
  return null
}

function startServer(port) {
  if (!existsSync(resolve('.next'))) {
    writeLog('config', 'no production build found, run: pnpm build')
    return null
  }

  const logPath = resolve('server.log')
  const out = createWriteStream(logPath, { flags: 'a' })
  const child = spawn('pnpm', ['exec', 'next', 'start', '-p', String(port)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  })
  child.stdout.pipe(out)
  child.stderr.pipe(out)
  child.on('error', (error) => writeLog('config', `server failed: ${error.message}`))
  child.unref()

  writeLog('config', `server starting on :${port} (log ${logPath})`)
  return child
}

/** Next.js needs a few seconds to bind, so a single probe would race it. */
async function waitForApp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let lastError = 'timed out'
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/api/miner/telemetry?since=0`)
      if (res.ok) return null
      lastError = `HTTP ${res.status}`
    } catch (error) {
      lastError = error.message
    }
    await new Promise((done) => setTimeout(done, 1000))
  }
  return lastError
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
  if (server) {
    // The server was spawned detached, so kill the whole process group.
    try {
      process.kill(-server.pid, 'SIGTERM')
    } catch {
      server.kill('SIGTERM')
    }
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

/**
 * @sparticuz/chromium ships a compressed build and unpacks it on first use.
 * Doing that here keeps findChrome() synchronous everywhere else.
 */
async function unpackBundledChromium() {
  if (args.chrome || existsSync('/tmp/chromium')) return
  try {
    const { default: chromium } = await import('@sparticuz/chromium')
    const path = await chromium.executablePath()
    if (path) writeLog('config', `unpacked bundled chromium: ${path}`)
  } catch {
    // Not installed, other detection paths still apply.
  }
}

if (args.doctor) {
  printBanner()
  await unpackBundledChromium()
  const ok = printChromeReport()
  process.exit(ok ? 0 : 1)
}

printBanner()
await unpackBundledChromium()

if (args.serve && !args.url) {
  const port = await pickPort(args.port)
  if (port === null) {
    writeLog('config', `no free port in ${args.port}-${args.port + 19}`)
    process.exit(1)
  }
  if (port !== args.port) writeLog('config', `port ${args.port} busy, using ${port}`)
  baseUrl = `http://127.0.0.1:${port}`
  server = startServer(port)
  if (!server) process.exit(1)
}

const unreachable = await waitForApp(baseUrl, args.serve ? 90_000 : 5_000)
if (unreachable) {
  writeLog('config', `cannot reach ${baseUrl} (${unreachable})`)
  writeLog('config', `start the app first: pnpm exec next start -p ${args.port}`)
  writeLog('config', 'or let this command start it: --serve')
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
