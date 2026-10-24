/* eslint-disable */
// Hashing worker. Loads the Emscripten build (engine-core.js) which exposes
// WasmBrowser() -> Module with two C exports: sha256d_str and miner_thread.
importScripts('/miner/engine-core.js')

const MIN_BATCH = 500
const MAX_BATCH = 400000
// How long one uninterrupted hashing slice runs before yielding. Long enough
// that scheduling overhead disappears, short enough that a new job or a stop
// message is picked up promptly.
const SLICE_MS = 200
// Target duration of a single wasm call, used to size the next batch.
const BATCH_TARGET_MS = 25
const MAX_NONCE = 0xfffffffe

let batchSize = 2000

const workerId = new URLSearchParams(self.location.search).get('id') || '0'

let sha256d = null
let minerThread = null
let ready = false
let job = null
let generation = 0
let running = false
const queued = []

// setTimeout(0) is clamped to ~4ms once nested, which costs a measurable slice
// of every batch. A MessageChannel port yields to the event loop with no clamp.
const scheduler = new MessageChannel()
scheduler.port1.onmessage = () => runSlice()
const yieldToEventLoop = () => scheduler.port2.postMessage(0)

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
  const merkle = j.merkleBranch.join('')
  const root = sha256d(j.coinb1, j.extraNonce1, extraNonce2, j.coinb2, merkle)
  const header = j.version + j.prevhash + root + j.ntime + j.nbits + '00000000'
  headerCache = { jobId: j.jobId, extraNonce2, header }
  return header
}

function swapEndian32(hex) {
  return hex.match(/.{2}/g).reverse().join('')
}

function stopMining() {
  generation++
  running = false
}

function startMining() {
  stopMining()
  if (!job) return
  running = true
  yieldToEventLoop()
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
      postMessage({ type: 'error', workerId, message: String(err && err.message) })
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
      if (nonce && nonce.length === 8) {
        postMessage({
          type: 'share',
          workerId,
          data: { jobId: snap.jobId, extraNonce2, ntime: snap.ntime, nonce },
        })
      }
    }
  }

  const elapsed = performance.now() - startedAt
  if (elapsed > 0) {
    const rate = hashed / (elapsed / 1000)
    postMessage({ type: 'hashrate', workerId, hashrate: rate })
    const ideal = Math.round((rate * BATCH_TARGET_MS) / 1000)
    batchSize = Math.max(MIN_BATCH, Math.min(MAX_BATCH, ideal))
  }

  yieldToEventLoop()
}

self.addEventListener('message', (event) => {
  const msg = event.data
  if (!msg || typeof msg !== 'object') return

  if (msg.type === 'stop') {
    stopMining()
    job = null
    return
  }

  if (msg.type === 'work') {
    const apply = () => {
      job = {
        ...msg.data,
        startNonce: 0,
        extraNonce2: randomExtraNonce2(msg.data.extraNonce2Size),
      }
      startMining()
    }
    if (ready) apply()
    else queued.push(apply)
  }
})

WasmBrowser().then((Module) => {
  sha256d = Module.cwrap('sha256d_str', 'string', ['string', 'string', 'string', 'string', 'string'])
  minerThread = Module.cwrap('miner_thread', 'string', ['string', 'string', 'number', 'number'])
  ready = true
  postMessage({ type: 'ready', workerId })
  while (queued.length) queued.shift()()
})
