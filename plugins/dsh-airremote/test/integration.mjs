/**
 * Host-side integration tests, run with `node test/integration.mjs`.
 * They exercise the real WebSocket implementation, the simulated board, UDP
 * discovery, the board session and the browser audio route without hardware.
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { AudioRoute, BoardDiscovery, BoardSession, FakeBoard, acceptWebSocket, connectWebSocket } from './dist/host-test.js'

const TOKEN = 'a'.repeat(64)
const SIM_PORT = 48684
const DISCOVERY_PORT = 48682

function waitFor(predicate, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer)
        resolve()
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer)
        reject(new Error(`timeout waiting for ${label}`))
      }
    }, 10)
  })
}

function config() {
  return {
    dataDir: '.',
    pairingToken: TOKEN,
    caFile: '',
    boardHost: '',
    boardPort: SIM_PORT,
    discoveryPort: DISCOVERY_PORT,
    discoveryTimeoutMs: 5000,
    simulate: true,
    simWav: '',
    simPort: SIM_PORT
  }
}

async function testWebSocketRoundTrip() {
  const server = createServer((_req, res) => {
    res.writeHead(404)
    res.end()
  })
  const received = []
  let serverConnection
  server.on('upgrade', (req, socket, head) => {
    serverConnection = acceptWebSocket(req, socket, head, {
      onMessage: (message) => {
        received.push(message)
        if (message.type === 'text') serverConnection.sendText(`echo:${message.text}`)
        else serverConnection.sendBinary(Buffer.from([1, 2, 3]))
      }
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const client = await connectWebSocket({ host: '127.0.0.1', port, path: '/ws' }, {
    onMessage: (message) => {
      if (message.type === 'text') received.push(message)
    }
  })
  client.sendText('hello')
  client.sendBinary(Buffer.from([9, 8, 7]))
  await waitFor(() => received.length >= 3, 2000, 'ws round trip')
  assert.equal(received[0].text, 'hello')
  assert.deepEqual([...received[1].data], [9, 8, 7])
  assert.equal(received[2].text, 'echo:hello')
  client.close()
  server.close()
  console.log('ok  websocket handshake + text/binary round trip')
}

async function testFakeBoardDiscoveryAndSession() {
  const board = new FakeBoard({ port: SIM_PORT, token: TOKEN, wavPath: 'does-not-exist.wav', discoveryPort: DISCOVERY_PORT })
  await board.start()
  const discovery = new BoardDiscovery({ port: DISCOVERY_PORT })
  await discovery.start()
  const announcement = await discovery.wait(3000)
  assert.equal(announcement.host, '127.0.0.1')
  assert.equal(announcement.mac, '02:00:00:00:00:01')

  const frames = []
  let ended
  const session = new BoardSession({
    config: config(),
    discovery,
    events: {
      onPcm: (pcm, sequence) => frames.push({ pcm, sequence }),
      onEnd: (reason, detail) => {
        ended = { reason, detail }
      }
    }
  })
  await session.start()
  await waitFor(() => frames.length >= 20, 6000, 'board PCM frames')
  assert.equal(frames[0].pcm.length, 640)
  assert.ok(frames[0].sequence >= 0)
  await session.stop({ draft: true })
  await waitFor(() => ended !== undefined, 3000, 'board session end')
  assert.equal(ended.reason, 'draft')
  console.log(`ok  fake board + discovery + session (${frames.length} frames, 640 bytes each)`)

  discovery.close()
  board.stop()
}

async function testAudioRoute() {
  const board = new FakeBoard({ port: SIM_PORT + 1, token: TOKEN, wavPath: 'does-not-exist.wav', discoveryPort: DISCOVERY_PORT + 1 })
  await board.start()
  const discovery = new BoardDiscovery({ port: DISCOVERY_PORT + 1 })
  await discovery.start()
  const route = new AudioRoute({
    config: { ...config(), discoveryPort: DISCOVERY_PORT + 1 },
    discovery,
    simulation: { host: '127.0.0.1', port: SIM_PORT + 1 }
  })
  const server = createServer((_req, res) => {
    res.writeHead(404)
    res.end()
  })
  server.on('upgrade', route.handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port

  const binary = []
  const states = []
  let ended
  const client = await connectWebSocket({ host: '127.0.0.1', port, path: '/airremote/audio' }, {
    onMessage: (message) => {
      if (message.type === 'binary') binary.push(message.data)
      else {
        const parsed = JSON.parse(message.text)
        if (parsed.type === 'state') states.push(parsed.state)
        if (parsed.type === 'ended') ended = parsed
      }
    }
  })
  client.sendText(JSON.stringify({ type: 'start' }))
  await waitFor(() => binary.length >= 10 && states.includes('live'), 6000, 'audio route frames')
  client.sendText(JSON.stringify({ type: 'stop', draft: true }))
  await waitFor(() => ended !== undefined, 3000, 'audio route end')
  assert.equal(binary[0].length, 640)
  assert.ok(states.includes('live'))
  assert.equal(ended.reason, 'draft')
  console.log(`ok  audio route (${binary.length} browser frames, states=${states.join(',')})`)

  client.close()
  route.dispose()
  server.close()
  discovery.close()
  board.stop()
}

await testWebSocketRoundTrip()
await testFakeBoardDiscoveryAndSession()
await testAudioRoute()
console.log('all host integration tests passed')
