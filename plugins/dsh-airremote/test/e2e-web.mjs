/**
 * End-to-end proof through the real DSH Web GUI:
 *
 *   official voice-input mic -> our virtual microphone -> simulated board PCM
 *   -> official SenseVoice provider -> transcript written into the composer.
 *
 * The script opens the authenticated Web GUI in headless Chrome (a separate
 * client from the desktop window), creates a new session, clicks the official
 * microphone, records ~3 s of simulated board speech, stops, and waits for the
 * transcript in the composer.
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connectWebSocket } from './dist/host-test.js'
import { mintCookie } from './gui-auth.mjs'

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'
].find((path) => existsSync(path))
if (CHROME === undefined) throw new Error('Chrome not found')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

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
        if (data.error) pending.reject(new Error(data.error.message))
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
  once(method, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), timeoutMs)
      const listener = (params) => {
        clearTimeout(timer)
        this.listeners.get(method)?.delete(listener)
        resolve(params)
      }
      if (!this.listeners.has(method)) this.listeners.set(method, new Set())
      this.listeners.get(method).add(listener)
    })
  }
}

const profile = mkdtempSync(join(tmpdir(), 'dsh-e2e-'))
const port = 9335
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage',
  '--no-first-run', '--no-default-browser-check', '--autoplay-policy=no-user-gesture-required',
  `--remote-debugging-port=${String(port)}`, `--user-data-dir=${profile}`, 'about:blank'
], { stdio: 'ignore' })

try {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${String(port)}/json/version`)
      if (r.ok) break
    } catch {}
    await sleep(100)
  }
  const targets = await (await fetch(`http://127.0.0.1:${String(port)}/json/list`)).json()
  const page = targets.find((target) => target.type === 'page')
  const handlers = {}
  const ws = await connectWebSocket({ host: '127.0.0.1', port, path: new URL(page.webSocketDebuggerUrl).pathname }, handlers)
  const cdp = new Cdp(ws, handlers)
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  await cdp.send('Network.enable')
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false })
  const cookie = mintCookie()
  await cdp.send('Network.setCookie', {
    name: cookie.name, value: cookie.value, domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Strict'
  })
  await cdp.send('Network.setExtraHTTPHeaders', { headers: { cookie: cookie.header } })
  const loaded = cdp.once('Page.loadEventFired')
  await cdp.send('Page.navigate', { url: 'http://127.0.0.1:57648/' })
  await loaded

  const evaluate = async (expression) => {
    const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) throw new Error(`page exception: ${JSON.stringify(result.exceptionDetails)}`)
    return result.result.value
  }
  const waitFor = async (expression, timeoutMs, label) => {
    const started = Date.now()
    for (;;) {
      const value = await evaluate(expression)
      if (value) return value
      if (Date.now() - started > timeoutMs) throw new Error(`timeout waiting for ${label}`)
      await sleep(250)
    }
  }

  await waitFor(`document.querySelector('button[class*=fD5ZVa_trigger]')?.getAttribute('aria-label') === '开始录音'`, 30000, 'voice button ready')
  console.log('voice button ready')
  await sleep(800)
  const dismissed = await evaluate(`(()=>{const button=[...document.querySelectorAll('button')].find((item)=>item.innerText.trim()==='继续');if(!button)return false;button.click();return true})()`)
  console.log('preview notice dismissed:', dismissed)

  /* New session so the test draft never touches an existing conversation. */
  await evaluate(`(()=>{const button=document.querySelector('button.wtg9ga_newSession');if(!button)return false;button.click();return true})()`)
  await sleep(1500)
  console.log('composer before:', JSON.stringify(await evaluate(`(()=>{const el=document.querySelector('[contenteditable="true"]');return el?el.innerText:''})()`)))

  const devices = await evaluate(`navigator.mediaDevices.enumerateDevices().then(d=>d.filter(x=>x.kind==='audioinput').map(x=>({id:x.deviceId,label:x.label})))`)
  console.log('inputs:', JSON.stringify(devices))
  const pref = await evaluate(`localStorage.getItem('dsh.voice-input.microphone')`)
  console.log('microphone preference:', pref)
  if (!String(pref).includes('airremote')) throw new Error('official plugin is not selecting the Air Remote microphone')

  await evaluate(`(()=>{
    window.__gumCalls=[]; window.__mrStarts=0;
    const gum=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia=(c)=>{window.__gumCalls.push(JSON.stringify(c));return gum(c)};
    const start=MediaRecorder.prototype.start;
    MediaRecorder.prototype.start=function(...a){window.__mrStarts++;return start.apply(this,a)};
    return true
  })()`)

  await evaluate(`document.querySelector('button[class*=fD5ZVa_trigger]').click()`)
  await sleep(1200)
  console.log('after click:', await evaluate(`JSON.stringify({gum:window.__gumCalls,starts:window.__mrStarts,text:document.body.innerText.split('\\n').filter(l=>/Air Remote|录音|等待|连接|失败|错误|麦克风/.test(l)).slice(0,12)})`))
  await sleep(2000)
  const stopClicked = await evaluate(`(()=>{const button=document.querySelector('button[aria-label="停止并识别"]');if(!button)return false;button.click();return true})()`)
  console.log('stop clicked:', stopClicked)
  if (!stopClicked) throw new Error('official stop button not found while recording')
  console.log('stopped; waiting for transcription')

  await sleep(12000)
  console.log('after stop:', await evaluate(`JSON.stringify({gum:window.__gumCalls,starts:window.__mrStarts,text:document.body.innerText.split('\\n').filter(l=>/Air Remote|录音|识别|语音|失败|错误|麦克风|未检测|草稿/.test(l)).slice(0,20),buttons:[...document.querySelectorAll('button')].map(b=>b.getAttribute('aria-label')).filter(Boolean).filter(a=>/语音|录音|识别|取消|重试/.test(a))})`))

  const composerText = `(()=>{const el=document.querySelector('[contenteditable="true"]');return el?el.innerText:''})()`
  const transcript = await waitFor(
    `(()=>{const el=document.querySelector('[contenteditable="true"]');const text=el?el.innerText.trim():'';return text.length>0?text:''})()`,
    90000,
    'transcript in composer'
  )
  console.log('draft:', JSON.stringify(transcript))

  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
  const shotPath = new URL('./dist/e2e-web.png', import.meta.url)
  writeFileSync(shotPath, Buffer.from(shot.data, 'base64'))
  console.log('screenshot:', shotPath.pathname)

  if (!/[\u4e00-\u9fff]/.test(transcript)) throw new Error(`transcript does not look like the simulated Chinese speech: ${transcript}`)
  console.log('ok  end-to-end: official mic -> Air Remote virtual mic -> SenseVoice -> composer draft')
  ws.close()
} finally {
  chrome.kill()
  await sleep(500)
  try { rmSync(profile, { recursive: true, force: true }) } catch {}
}
