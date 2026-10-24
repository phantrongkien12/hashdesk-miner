/* eslint-disable */
// Hashing worker. Loads the Emscripten build (engine-core.js) which exposes
// WasmBrowser() -> Module with two C exports: sha256d_str and miner_thread.
importScripts('/miner/engine-core.js')

// A browser CPU manages a few hundred hashes per second, so the batch has to
// adapt: too large and the worker blocks for minutes before reporting anything.
const MIN_BATCH = 250
const MAX_BATCH = 250000
const TARGET_BATCH_MS = 120
const MAX_NONCE = 0xfffffffe

let batchSize = 1000

const workerId = new URLSearchParams(self.location.search).get('id') || '0'

let sha256d = null
let minerThread = null
let ready = false
let job = null
let generation = 0
let timer = null
const queued = []

function randomExtraNonce2(size) {
  let out = ''
  for (let i = 0; i < size * 2; i++) out += Math.floor(Math.random() * 16).toString(16)
  return out
}

function buildHeader(j, extraNonce2) {
  const merkle = j.merkleBranch.join('')
  const root = sha256d(j.coinb1, j.extraNonce1, extraNonce2, j.coinb2, merkle)
  return j.version + j.prevhash + root + j.ntime + j.nbits + '00000000'
}

function swapEndian32(hex) {
  return hex.match(/.{2}/g).reverse().join('')
}

function stopMining() {
  generation++
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
}

function startMining() {
  stopMining()
  if (!job) return

  const snap = job
  const gen = generation

  const runBatch = () => {
    if (gen !== generation) return

    const extraNonce2 = snap.extraNonce2
    const header = buildHeader(snap, extraNonce2)
    const first = snap.startNonce
    const last = Math.min(first + batchSize - 1, MAX_NONCE)
    const count = last - first + 1

    const startedAt = performance.now()
    let result
    try {
      result = minerThread(header, String(snap.miningDiff), first, last)
    } catch (err) {
      postMessage({ type: 'error', workerId, message: String(err && err.message) })
      timer = setTimeout(runBatch, 250)
      return
    }
    const elapsed = performance.now() - startedAt

    if (elapsed > 0) {
      const rate = count / (elapsed / 1000)
      postMessage({ type: 'hashrate', workerId, hashrate: rate })
      const ideal = Math.round((rate * TARGET_BATCH_MS) / 1000)
      batchSize = Math.max(MIN_BATCH, Math.min(MAX_BATCH, ideal))
    }

    const found = (result || '').split(',')[0]

    if (last >= MAX_NONCE) {
      snap.extraNonce2 = randomExtraNonce2(snap.extraNonce2Size)
      snap.startNonce = 0
    } else {
      snap.startNonce = last + 1
    }

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

    timer = setTimeout(runBatch, 0)
  }

  timer = setTimeout(runBatch, 0)
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
