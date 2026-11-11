/**
 * Headless-browser proof for the virtual microphone.
 *
 * Serves the built shim plus a test page, runs Chrome/Edge through the
 * DevTools protocol, installs the shim, records a synthetic `airremote` stream
 * with MediaRecorder, decodes the produced WebM, and checks that it contains
 * non-silent audio. This is the compatibility risk the design hinges on.
 */

import { createServer } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acceptWebSocket, connectWebSocket } from './dist/host-test.js'

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe'
]

const TOKEN = 'b'.repeat(64)
const FRAME_SAMPLES = 320
const SAMPLE_RATE = 16_000

function toneFrame(sequence) {
  const pcm = Buffer.allocUnsafe(FRAME_SAMPLES * 2)
  for (let i = 0; i < FRAME_SAMPLES; i++) {
    const n = sequence * FRAME_SAMPLES + i
    pcm.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * n) / SAMPLE_RATE) * 0.25 * 32767), i * 2)
  }
  return pcm
}

function startAudioServer() {
  let browserSocket
  let timer
  let sequence = 0
  let started = false
  const server = createServer((req, res) => {
    if (req.url === '/' || req.url === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(readFileSync(new URL('./browser-test.html', import.meta.url)))
      return
    }
    if (req.url === '/virtual-mic.test.js') {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' })
      res.end(readFileSync(new URL('./dist/virtual-mic.test.js', import.meta.url)))
      return
    }
    res.writeHead(404)
    res.end()
  })
  server.on('upgrade', (req, socket, head) => {
    browserSocket = acceptWebSocket(req, socket, head, {
      onMessage: (message) => {
        if (message.type !== 'text') return
        let parsed
        try {
          parsed = JSON.parse(message.text)
        } catch {
          return
        }
        if (parsed.type === 'start' && !started) {
          started = true
          browserSocket.sendText(JSON.stringify({ type: 'hello', device: 'Air Remote (ESP32-C6)' }))
          browserSocket.sendText(JSON.stringify({ type: 'state', state: 'live', detail: '录音中' }))
          timer = setInterval(() => {
            browserSocket.sendBinary(toneFrame(sequence++))
          }, 20)
        }
        if (parsed.type === 'stop') {
          clearInterval(timer)
          timer = undefined
          browserSocket.sendText(JSON.stringify({ type: 'ended', reason: 'draft', detail: '测试完成' }))
          setTimeout(() => browserSocket?.close(), 50)
        }
      },
      onClose: () => {
        clearInterval(timer)
        timer = undefined
      }
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

function findChrome() {
  for (const path of CHROME_CANDIDATES) {
    if (existsSync(path)) return path
  }
  throw new Error('no Chrome/Edge executable found')
}

async function waitForHttp(url, timeoutMs) {
  const started = Date.now()
  for (;;) {
    try {
      const response = await fetch(url)
      if (response.ok) return response
    } catch {
      /* not up yet */
    }
    if (Date.now() - started > timeoutMs) throw new Error(`timeout waiting for ${url}`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

class Cdp {
  constructor(ws, handlers) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    this.listeners = new Map()
    handlers.onMessage = (message) => {
      if (message.type !== 'text') return
      const data = JSON.parse(message.text)
      if (typeof data.id === 'number') {
        const pending = this.pending.get(data.id)
        if (pending === undefined) return
        this.pending.delete(data.id)
        if (data.error) pending.reject(new Error(`${data.error.message} (${JSON.stringify(data.error.data ?? '')})`))
        else pending.resolve(data.result)
        return
      }
      for (const listener of this.listeners.get(data.method) ?? []) listener(data.params)
    }
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.id
      this.pending.set(id, { resolve, reject })
      this.ws.sendText(JSON.stringify({ id, method, params }))
    })
  }

  once(method, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.listeners.get(method)?.delete?.(listener)
        reject(new Error(`timeout waiting for CDP event ${method}`))
      }, timeoutMs)
      const listener = (params) => {
        clearTimeout(timer)
        this.listeners.get(method)?.delete?.(listener)
        resolve(params)
      }
      if (!this.listeners.has(method)) this.listeners.set(method, new Set())
      this.listeners.get(method).add(listener)
    })
  }
}

const chrome = findChrome()
const profile = mkdtempSync(join(tmpdir(), 'dsh-airremote-chrome-'))
const debugPort = 9333
const chromeProcess = spawn(
  chrome,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--no-first-run',
    '--no-default-browser-check',
    '--autoplay-policy=no-user-gesture-required',
    `--remote-debugging-port=${String(debugPort)}`,
    `--user-data-dir=${profile}`,
    'about:blank'
  ],
  { stdio: 'ignore' }
)

let audio
try {
  audio = await startAudioServer()
  console.log(`test server on http://127.0.0.1:${String(audio.port)}`)
  await waitForHttp(`http://127.0.0.1:${String(debugPort)}/json/version`, 15000)
  console.log('chrome debugger is up')
  const targets = await (await fetch(`http://127.0.0.1:${String(debugPort)}/json/list`)).json()
  const page = targets.find((target) => target.type === 'page')
  if (page === undefined) throw new Error('no page target in Chrome')
  console.log(`page target ${page.url}`)
  const handlers = {}
  const ws = await connectWebSocket(
    { host: '127.0.0.1', port: debugPort, path: new URL(page.webSocketDebuggerUrl).pathname },
    handlers
  )
  console.log('cdp connected')
  const cdp = new Cdp(ws, handlers)
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  const loaded = cdp.once('Page.loadEventFired')
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${String(audio.port)}/` })
  await loaded
  console.log('test page loaded')
  const evaluated = await cdp.send('Runtime.evaluate', {
    expression: 'window.__runTest()',
    awaitPromise: true,
    returnByValue: true
  })
  console.log('evaluated')
  if (evaluated.exceptionDetails) {
    throw new Error(`page test threw: ${JSON.stringify(evaluated.exceptionDetails)}`)
  }
  const result = evaluated.result.value
  console.log(JSON.stringify(result, null, 2))
  if (result?.ok !== true) throw new Error('virtual microphone browser test failed')
  console.log('ok  headless Chrome: enumerateDevices + getUserMedia + MediaRecorder on synthetic stream')
  ws.close()
} finally {
  audio?.server.close()
  chromeProcess.kill()
  await new Promise((resolve) => setTimeout(resolve, 300))
  try {
    rmSync(profile, { recursive: true, force: true })
  } catch {
    /* Chrome may still hold a file */
  }
}
