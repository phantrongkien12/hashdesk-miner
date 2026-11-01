/**
 * A stratum relay that runs inside the miner process.
 *
 * The app talks stratum over a WebSocket because a browser cannot open a TCP
 * socket, and a hosted relay bridges that WebSocket to the pool. Those hosted
 * relays are a shared dependency: when one is down, every miner pointed at it
 * stops earning. A machine running the CLI can open TCP itself, so this serves
 * the same bridge from loopback and leaves the hosted relay as a fallback.
 *
 * The pool address travels in the path as base64, exactly as the hosted relays
 * expect, so the client needs no changes to use either one.
 */
import { createServer } from 'node:http'
import { connect } from 'node:net'
import { StringDecoder } from 'node:string_decoder'
import { WebSocketServer } from 'ws'

const WS_OPEN = 1
/** Frames held while the TCP handshake is in flight. */
const MAX_QUEUED_FRAMES = 64

export async function startLocalRelay({ host = '127.0.0.1', port = 0 } = {}) {
  const server = createServer((request, response) => {
    response.writeHead(426, { 'content-type': 'text/plain' })
    response.end('websocket only\n')
  })

  const wss = new WebSocketServer({ server, maxPayload: 1 << 20 })
  wss.on('error', () => {
    // A failed upgrade is the client's problem; the server stays up for the
    // next attempt rather than taking the miner down with it.
  })

  wss.on('connection', (socket, request) => {
    if (!originAllowed(request.headers.origin)) {
      socket.close(1008, 'origin not allowed')
      return
    }
    const target = decodeTarget(request.url)
    if (!target) {
      socket.close(1008, 'target not allowed')
      return
    }
    bridge(socket, target)
  })

  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error)
    server.once('error', onError)
    server.listen(port, host, () => {
      server.off('error', onError)
      resolve()
    })
  })

  const address = server.address()
  const boundPort = typeof address === 'object' && address ? address.port : port

  return {
    url: `ws://${host}:${boundPort}`,
    port: boundPort,
    close: () =>
      new Promise((resolve) => {
        for (const client of wss.clients) client.terminate()
        wss.close(() => server.close(() => resolve()))
      }),
  }
}

/**
 * Prefers a relay in this process and falls back to the hosted one only when
 * the port cannot be bound, so a locked-down machine still mines.
 */
export async function resolveRelay({ explicit = null, log = () => {} } = {}) {
  if (explicit) return { url: explicit, local: false, close: async () => {} }

  try {
    const relay = await startLocalRelay()
    log(`local relay ${relay.url}`)
    return { url: relay.url, local: true, close: relay.close }
  } catch (error) {
    log(`local relay unavailable (${error.message}), using the hosted relay`)
    return { url: null, local: false, close: async () => {} }
  }
}

function bridge(socket, target) {
  const upstream = connect({ host: target.host, port: target.port })
  upstream.setNoDelay(true)
  upstream.setKeepAlive(true, 30_000)

  // The client sends mining.subscribe the moment the WebSocket opens, which can
  // beat the TCP handshake, so early frames wait for the pool to come up.
  const queued = []
  let closed = false

  const stop = (code, reason) => {
    if (closed) return
    closed = true
    try {
      socket.close(code, reason)
    } catch {
      // already gone
    }
    upstream.destroy()
  }

  socket.on('message', (data) => {
    if (upstream.readyState === 'open') upstream.write(data)
    else if (queued.length < MAX_QUEUED_FRAMES) queued.push(data)
  })

  upstream.on('connect', () => {
    for (const frame of queued) upstream.write(frame)
    queued.length = 0
  })

  // Text frames, not binary. The client reads String(event.data), and a binary
  // frame reaches the browser as a Blob, so String() yields "[object Blob]" and
  // every reply is silently dropped. The decoder keeps a multi-byte character
  // intact when a chunk boundary splits it.
  const decoder = new StringDecoder('utf8')
  upstream.on('data', (chunk) => {
    if (socket.readyState === WS_OPEN) socket.send(decoder.write(chunk))
  })

  upstream.on('error', (error) => stop(1011, error.code || 'pool unreachable'))
  upstream.on('close', () => stop(1000, 'pool closed'))
  socket.on('close', () => stop(1000, 'client closed'))
  socket.on('error', () => stop(1011, 'client error'))
}

function decodeTarget(rawUrl) {
  const path = (rawUrl || '').split('?')[0].replace(/^\/+/, '')
  if (!path) return null

  const decoded = Buffer.from(path, 'base64').toString('utf8')
  const match = /^([A-Za-z0-9._-]+):(\d{1,5})$/.exec(decoded)
  if (!match) return null

  const port = Number(match[2])
  if (port < 1 || port > 65535) return null
  return { host: match[1], port }
}

/**
 * Loopback only. The server already binds 127.0.0.1, but without this check any
 * page the user has open could reach it and use it as a TCP proxy.
 */
function originAllowed(origin) {
  if (!origin) return true
  try {
    const { hostname } = new URL(origin)
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]'
  } catch {
    return false
  }
}
