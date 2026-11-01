/**
 * The miner scripts were written for a Linux VPS. This module holds the few
 * places where Windows genuinely differs, so the rest of the code stays
 * platform-agnostic:
 *
 * - Windows has no process groups, so a tree kill needs `taskkill /T`.
 * - `ps` and `which` do not exist; `tasklist` and `where` do, but `tasklist`
 *   only reports the image name, so the command line needs PowerShell.
 * - Chrome lives under LOCALAPPDATA / PROGRAMFILES, and `chrome.exe --version`
 *   opens a window instead of printing, so the version comes from the file.
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { win32 } from 'node:path'

export const isWindows = process.platform === 'win32'

/** Keeps a console window from flashing up for every child process. */
export const hidden = isWindows ? { windowsHide: true } : {}

function run(file, argv, options = {}) {
  return execFileSync(file, argv, {
    encoding: 'utf8',
    timeout: 8000,
    stdio: ['ignore', 'pipe', 'ignore'],
    ...hidden,
    ...options,
  }).trim()
}

/**
 * Kills a process and everything it spawned. On POSIX the children are found
 * through the process group, which only exists because the caller spawned
 * detached. Windows has no such group, so taskkill walks the tree itself.
 */
export function killTree(pid, force = true) {
  if (!Number.isInteger(pid) || pid <= 0) return
  if (isWindows) {
    try {
      run('taskkill', ['/PID', String(pid), '/T', ...(force ? ['/F'] : [])])
    } catch {
      // Already gone, or access denied on a process we do not own.
    }
    return
  }
  try {
    process.kill(-pid, force ? 'SIGKILL' : 'SIGTERM')
  } catch {
    try {
      process.kill(pid, force ? 'SIGKILL' : 'SIGTERM')
    } catch {
      // Raced with its own exit.
    }
  }
}

/**
 * Guards against killing an unrelated process that reused a stale pid, so the
 * pattern is matched against the full command line rather than the image name.
 */
export function processMatches(pid, pattern) {
  if (!Number.isInteger(pid) || pid <= 0) return false

  if (isWindows) {
    try {
      const line = run('powershell', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`,
      ])
      if (line) return pattern.test(line)
    } catch {
      // PowerShell missing or blocked, fall through to the image name.
    }
    try {
      const csv = run('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'])
      return pattern.test(csv)
    } catch {
      return false
    }
  }

  try {
    return pattern.test(run('ps', ['-p', String(pid), '-o', 'args=']))
  } catch {
    return false
  }
}

/** `which` on POSIX, `where` on Windows. Returns the first hit that exists. */
export function findOnPath(names) {
  const tool = isWindows ? 'where' : 'which'
  for (const name of names) {
    try {
      const out = run(tool, [name], { timeout: 3000 })
      const first = out.split(/\r?\n/)[0].trim()
      if (first && existsSync(first)) return first
    } catch {
      // Not on PATH, keep looking.
    }
  }
  return null
}

/** Chrome and Chromium install to a handful of fixed places on Windows. */
export function chromeCandidates() {
  if (isWindows) {
    const roots = [
      process.env.LOCALAPPDATA,
      process.env.PROGRAMFILES,
      process.env['PROGRAMFILES(X86)'],
    ].filter(Boolean)

    return [
      process.env.CHROME_BIN,
      ...roots.flatMap((root) => [
        win32.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        win32.join(root, 'Chromium', 'Application', 'chrome.exe'),
        win32.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      ]),
    ].filter(Boolean)
  }

  return [
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
}

export function chromeInstallHint() {
  return isWindows
    ? 'install with: winget install Google.Chrome'
    : 'install without root: npx @puppeteer/browsers install chrome@stable'
}

/**
 * A Chrome binary that exists but cannot start is the common case on a VPS:
 * the download succeeds, then the loader fails on missing system libraries.
 * Reporting "unknown" hides that, so the failure is classified here.
 *
 * Windows has no equivalent probe: `chrome.exe --version` opens a window
 * instead of printing, so the version is read from the executable metadata.
 */
export function probeChrome(path) {
  if (isWindows) {
    try {
      const version = run('powershell', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(Get-Item -LiteralPath '${path.replace(/'/g, "''")}').VersionInfo.ProductVersion`,
      ])
      return { state: 'ok', version: version ? `chrome/${version}` : 'chrome', missing: [] }
    } catch {
      // The file exists, so treat it as usable and let the launch report.
      return { state: 'ok', version: 'chrome', missing: [] }
    }
  }

  try {
    const raw = run(path, ['--version'])
    return { state: 'ok', version: raw.replace(/\s+/g, '/').toLowerCase(), missing: [] }
  } catch (error) {
    const text = `${error.stderr ?? ''}${error.stdout ?? ''}${error.message ?? ''}`
    const missing = [...new Set(text.match(/lib[\w.+-]+\.so[\w.]*/g) ?? [])]
    return { state: 'broken', version: null, missing }
  }
}
