import { parentPort } from 'node:worker_threads'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Same Emscripten build the browser worker loads. It is a single-file bundle
// with the wasm embedded, so it needs no fetch and runs unmodified in Node.
const enginePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'public',
  'miner',
  'engine-core.js',
)
const WasmBrowser = new Function(`${fs.readFileSync(enginePath, 'utf8')}; return WasmBrowser;`)()

const MIN_BATCH = 500
const MAX_BATCH = 400_000
const BATCH_TARGET_MS = 25
const SLICE_MS = 200
const MAX_NONCE = 0xfffffffe

let sha256d = null
let minerThread = null
let batchSize = 2000
let job = null
let generation = 0
let running = false
let totalHashed = 0
let headerCache = { jobId: null, extraNonce2: null, header: '' }

function randomExtraNonce2(size) {
  let out = ''
  for (let i = 0; i < size * 2; i++) out += Math.floor(Math.random() * 16).toString(16)
  return out
}

// The coinbase-derived header only changes when extraNonce2 rotates, so the
// sha256d round trip is skipped for every batch in between.
function headerFor(j, extraNonce2) {
  if (headerCache.jobId === j.jobId && headerCache.extraNonce2 === extraNonce2) {
    return headerCache.header
  }
  const root = sha256d(j.coinb1, j.extraNonce1, extraNonce2, j.coinb2, j.merkleBranch.join(''))
  const header = j.version + j.prevhash + root + j.ntime + j.nbits + '00000000'
  headerCache = { jobId: j.jobId, extraNonce2, header }
  return header
}

function swapEndian32(hex) {
  return hex.match(/.{2}/g).reverse().join('')
}

function runSlice() {
  if (!running || !job) return

  const snap = job
  const gen = generation
  const startedAt = performance.now()
  const deadline = startedAt + SLICE_MS
  let hashed = 0

  while (performance.now() < deadline) {
    if (gen !== generation) return

    const extraNonce2 = snap.extraNonce2
    const header = headerFor(snap, extraNonce2)
    const first = snap.startNonce
    const last = Math.min(first + batchSize - 1, MAX_NONCE)
    const count = last - first + 1

    let result
    try {
      result = minerThread(header, String(snap.miningDiff), first, last)
    } catch (err) {
      parentPort.postMessage({ type: 'error', message: String(err?.message ?? err) })
      running = false
      return
    }

    hashed += count

    if (last >= MAX_NONCE) {
      snap.extraNonce2 = randomExtraNonce2(snap.extraNonce2Size)
      snap.startNonce = 0
    } else {
      snap.startNonce = last + 1
    }

    const found = (result || '').split(',')[0]
    if (found && found.length === 8) {
      const nonce = swapEndian32(found)
      if (nonce.length === 8) {
        parentPort.postMessage({
          type: 'share',
          data: { jobId: snap.jobId, extraNonce2, ntime: snap.ntime, nonce },
        })
      }
    }
  }

  totalHashed += hashed
  const elapsed = performance.now() - startedAt
  if (elapsed > 0) {
    const rate = hashed / (elapsed / 1000)
    parentPort.postMessage({ type: 'hashrate', hashrate: rate, hashed: totalHashed })
    batchSize = Math.max(MIN_BATCH, Math.min(MAX_BATCH, Math.round((rate * BATCH_TARGET_MS) / 1000)))
  }

  setImmediate(runSlice)
}

parentPort.on('message', (msg) => {
  if (!msg || typeof msg !== 'object') return

  if (msg.type === 'stop') {
    generation++
    running = false
    job = null
    return
  }

  if (msg.type === 'work') {
    job = {
      ...msg.data,
      startNonce: 0,
      extraNonce2: randomExtraNonce2(msg.data.extraNonce2Size),
    }
    generation++
    running = true
    setImmediate(runSlice)
  }
})

WasmBrowser().then((Module) => {
  sha256d = Module.cwrap('sha256d_str', 'string', ['string', 'string', 'string', 'string', 'string'])
  minerThread = Module.cwrap('miner_thread', 'string', ['string', 'string', 'number', 'number'])
  parentPort.postMessage({ type: 'ready' })
})
