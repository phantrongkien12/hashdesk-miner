#!/usr/bin/env node
/**
 * Keeps the miner running when the system kills it.
 *
 * The OOM killer sends SIGKILL, which no in-process handler can catch, so
 * surviving it needs a parent process. This wrapper restarts mine-tui with
 * backoff and passes every option straight through.
 *
 * Usage: node scripts/mine-supervisor.mjs --serve [any mine-tui option]
 */
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const BACKOFF = [2_000, 5_000, 10_000, 20_000, 30_000, 60_000]
const MAX_RESTARTS = 20
const HEALTHY_AFTER = 5 * 60_000

const entry = join(dirname(fileURLToPath(import.meta.url)), 'mine-tui.mjs')
const passthrough = process.argv.slice(2)

let child = null
let restarts = 0
let stopping = false
let healthyTimer = null

// stderr keeps the TUI's status line on stdout intact.
function log(line) {
  process.stderr.write(`[supervisor] ${line}\n`)
}

function start() {
  child = spawn(process.execPath, [entry, ...passthrough], { stdio: 'inherit' })

  healthyTimer = setTimeout(() => {
    if (restarts > 0) log('tool stayed up, resetting the restart count')
    restarts = 0
  }, HEALTHY_AFTER)
  healthyTimer.unref()

  child.on('error', (error) => log(`cannot start the tool: ${error.message}`))

  child.on('exit', (code, signal) => {
    clearTimeout(healthyTimer)
    if (stopping) process.exit(0)
    // Exit 0 is the user pressing q, not a crash.
    if (code === 0) process.exit(0)

    restarts += 1
    if (restarts > MAX_RESTARTS) {
      log(`gave up after ${MAX_RESTARTS} restarts`)
      process.exit(1)
    }
    const delay = BACKOFF[Math.min(restarts - 1, BACKOFF.length - 1)]
    log(
      `tool exited (${signal ?? `code ${code}`}), restarting in ${delay / 1000}s ` +
        `(${restarts}/${MAX_RESTARTS})`,
    )
    setTimeout(start, delay)
  })
}

process.on('SIGINT', () => {
  stopping = true
  child?.kill('SIGINT')
})
process.on('SIGTERM', () => {
  stopping = true
  child?.kill('SIGTERM')
})

start()
