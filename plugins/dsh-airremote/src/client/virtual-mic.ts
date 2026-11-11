/**
 * Virtual microphone shim for the official DSH voice-input plugin.
 *
 * The official plugin calls `navigator.mediaDevices.enumerateDevices()` to list
 * inputs and `getUserMedia({audio:{deviceId:{exact: id}}})` to acquire one. This
 * module appends a synthetic `airremote` input and, only for that id, returns a
 * `MediaStreamAudioDestinationNode` stream fed by the board PCM arriving over
 * `/airremote/audio`. Every other acquisition passes through untouched.
 *
 * Board audio is 16 kHz mono s16le; Web Audio resamples it to the output
 * context rate and schedules 20 ms buffers on a small jitter cushion. The
 * official MediaRecorder then records the destination stream exactly like a
 * physical microphone, so recognition, the draft write and the settings page
 * stay entirely owned by the official plugin.
 */

import type { VoiceState } from './voice-state.js'

export const VIRTUAL_DEVICE_ID = 'airremote'
export const VIRTUAL_DEVICE_LABEL = 'Air Remote (ESP32-C6)'
export const AUDIO_ROUTE = '/airremote/audio'
export const VOICE_PREFERENCE_KEY = 'dsh.voice-input.microphone'

const BOARD_SAMPLE_RATE = 16_000
const JITTER_SECONDS = 0.12
const START_LEAD_SECONDS = 0.08
const RECONNECT_DELAYS_MS = [1000, 2500, 5000]

export interface VirtualMicOptions {
  status?: VoiceState
  /** Override for tests; defaults to the origin of the page. */
  audioUrl?: string
}

interface SessionEntry {
  stream: MediaStream
  session: VirtualMicSession
}

const sessions = new Map<MediaStream, SessionEntry>()

function isVirtualConstraints(constraints: MediaStreamConstraints | undefined): boolean {
  const audio = constraints?.audio
  if (typeof audio !== 'object' || audio === null) return false
  const deviceId = (audio as MediaTrackConstraints).deviceId
  if (typeof deviceId === 'string') return deviceId === VIRTUAL_DEVICE_ID
  if (typeof deviceId === 'object' && deviceId !== null && 'exact' in deviceId) {
    const exact = (deviceId as { exact?: string | string[] }).exact
    if (typeof exact === 'string') return exact === VIRTUAL_DEVICE_ID
    if (Array.isArray(exact)) return exact.includes(VIRTUAL_DEVICE_ID)
  }
  return false
}

function audioUrl(options: VirtualMicOptions): string {
  if (options.audioUrl !== undefined) return options.audioUrl
  const injected = (globalThis as { __AIRREMOTE_AUDIO_URL__?: unknown }).__AIRREMOTE_AUDIO_URL__
  if (typeof injected === 'string' && injected !== '') return injected
  const origin = typeof location === 'undefined' ? '' : location.origin
  if (origin.startsWith('http://') || origin.startsWith('https://')) {
    return `${origin.replace(/^http/, 'ws')}${AUDIO_ROUTE}`
  }
  /* The Electron shell may load a custom scheme; the local web server is the carrier. */
  const port = typeof location === 'undefined' ? '57648' : location.port || '57648'
  return `ws://127.0.0.1:${port}${AUDIO_ROUTE}`
}

function decodePcm16(buffer: ArrayBuffer): Float32Array {
  const view = new DataView(buffer)
  const count = Math.floor(buffer.byteLength / 2)
  const samples = new Float32Array(count)
  for (let i = 0; i < count; i++) samples[i] = view.getInt16(i * 2, true) / 32768
  return samples
}

function resample(samples: Float32Array, from: number, to: number): Float32Array {
  if (from === to || samples.length === 0) return samples
  const ratio = to / from
  const length = Math.max(1, Math.round(samples.length * ratio))
  const out = new Float32Array(length)
  for (let i = 0; i < length; i++) {
    const position = i / ratio
    const left = Math.floor(position)
    const right = Math.min(samples.length - 1, left + 1)
    const fraction = position - left
    out[i] = samples[left]! * (1 - fraction) + samples[right]! * fraction
  }
  return out
}

class VirtualMicSession {
  readonly stream: MediaStream
  private readonly context: AudioContext
  private readonly destination: MediaStreamAudioDestinationNode
  private readonly track: MediaStreamTrack
  private readonly status: VoiceState | undefined
  private readonly url: string

  private ws: WebSocket | undefined
  private begun = false
  private ended = false
  private reconnectAttempt = 0
  private reconnectTimer: number | undefined
  private readonly pending: AudioBuffer[] = []
  private pendingSamples = 0
  private nextTime = 0
  private started = false
  private readonly sources = new Set<AudioBufferSourceNode>()
  private readonly resumeOnGesture = (): void => {
    void this.resume()
  }

  constructor(context: AudioContext, destination: MediaStreamAudioDestinationNode, status: VoiceState | undefined, url: string) {
    this.context = context
    this.destination = destination
    this.stream = destination.stream
    this.track = this.stream.getAudioTracks()[0]!
    this.status = status
    this.url = url
    this.labelTrack()
    this.patchTrackStop()
  }

  private labelTrack(): void {
    try {
      Object.defineProperty(this.track, 'label', { configurable: true, get: () => VIRTUAL_DEVICE_LABEL })
    } catch {
      /* label is informational; the device id is what matters */
    }
    try {
      const original = this.track.getSettings.bind(this.track)
      Object.defineProperty(this.track, 'getSettings', {
        configurable: true,
        value: () => ({ ...original(), deviceId: VIRTUAL_DEVICE_ID, groupId: VIRTUAL_DEVICE_ID })
      })
    } catch {
      /* the official plugin falls back to its stored selection */
    }
  }

  private patchTrackStop(): void {
    const original = this.track.stop.bind(this.track)
    try {
      Object.defineProperty(this.track, 'stop', {
        configurable: true,
        value: () => {
          original()
          this.dispose()
        }
      })
    } catch {
      /* ignore */
    }
    this.track.addEventListener('ended', () => this.dispose(), { once: true })
  }

  /** Called from the MediaRecorder.start patch, i.e. only for real capture, not settings previews. */
  begin(): void {
    if (this.begun || this.ended) return
    this.begun = true
    this.status?.set({ phase: 'connecting', detail: '正在连接开发板…' })
    void this.resume()
    if (typeof document !== 'undefined') document.addEventListener('pointerdown', this.resumeOnGesture, { once: true })
    this.connect()
  }

  private resume(): Promise<void> {
    if (this.context.state === 'suspended') return this.context.resume()
    return Promise.resolve()
  }

  private connect(): void {
    if (this.ended) return
    let socket: WebSocket
    try {
      socket = new WebSocket(this.url)
    } catch (error) {
      this.fail(`无法连接音频通道：${error instanceof Error ? error.message : String(error)}`)
      return
    }
    socket.binaryType = 'arraybuffer'
    this.ws = socket
    socket.onopen = () => {
      if (this.ended) {
        socket.close()
        return
      }
      this.reconnectAttempt = 0
      this.status?.set({ phase: 'waiting', detail: '等待开发板（请在板子上点 Voice）…' })
      socket.send(JSON.stringify({ type: 'start' }))
    }
    socket.onmessage = (event: MessageEvent) => {
      if (this.ended) return
      if (typeof event.data === 'string') {
        this.onControl(event.data)
      } else if (event.data instanceof ArrayBuffer) {
        this.ingest(event.data)
      }
    }
    socket.onerror = () => {
      /* onclose follows and owns the retry/state decision */
    }
    socket.onclose = () => {
      this.ws = undefined
      if (this.ended) return
      if (this.reconnectAttempt < RECONNECT_DELAYS_MS.length) {
        const delay = RECONNECT_DELAYS_MS[this.reconnectAttempt]!
        this.reconnectAttempt += 1
        this.status?.set({ phase: 'reconnecting', detail: `音频通道断开，${String(Math.round(delay / 1000))} 秒后重连…` })
        this.reconnectTimer = window.setTimeout(() => {
          this.reconnectTimer = undefined
          this.connect()
        }, delay)
      } else {
        this.fail('音频通道断开，请重新点击官方麦克风')
      }
    }
  }

  private onControl(text: string): void {
    let message: { type?: unknown; state?: unknown; detail?: unknown; reason?: unknown }
    try {
      message = JSON.parse(text) as typeof message
    } catch {
      return
    }
    if (message.type === 'state') {
      const state = typeof message.state === 'string' ? message.state : ''
      const detail = typeof message.detail === 'string' ? message.detail : ''
      if (state === 'live') this.status?.set({ phase: 'live', detail: detail === '' ? '录音中' : detail })
      else if (state === 'error') this.status?.set({ phase: 'error', detail })
      else if (state === 'ended') this.status?.set({ phase: 'done', detail })
      else this.status?.set({ phase: 'connecting', detail })
      return
    }
    if (message.type === 'ended') {
      const reason = typeof message.reason === 'string' ? message.reason : ''
      const detail = typeof message.detail === 'string' ? message.detail : ''
      this.ended = true
      sessions.delete(this.stream)
      this.stopSources()
      try {
        this.ws?.close()
      } catch {
        /* ignore */
      }
      this.ws = undefined
      if (reason === 'error' || reason === 'timeout') this.status?.set({ phase: 'error', detail })
      else this.status?.set({ phase: 'done', detail: detail === '' ? '已完成' : detail })
      this.scheduleClose()
      return
    }
    if (message.type === 'busy') {
      this.fail(typeof message.detail === 'string' ? message.detail : '另一个页面正在使用 Air Remote')
    }
  }

  private ingest(buffer: ArrayBuffer): void {
    if (buffer.byteLength < 2) return
    const mono = decodePcm16(buffer)
    const resampled = resample(mono, BOARD_SAMPLE_RATE, this.context.sampleRate)
    const audio = this.context.createBuffer(1, resampled.length, this.context.sampleRate)
    audio.getChannelData(0).set(resampled)
    this.pending.push(audio)
    this.pendingSamples += resampled.length
    this.pump()
  }

  private pump(): void {
    if (this.ended) return
    if (!this.started) {
      if (this.pendingSamples < this.context.sampleRate * JITTER_SECONDS) return
      this.started = true
      this.nextTime = this.context.currentTime + START_LEAD_SECONDS
    }
    while (this.pending.length > 0) {
      const buffer = this.pending.shift()!
      this.pendingSamples -= buffer.length
      if (this.nextTime < this.context.currentTime - 0.05) this.nextTime = this.context.currentTime + 0.05
      /* Do not queue more than a second ahead; drop frames rather than growing latency. */
      if (this.nextTime - this.context.currentTime > 1.0) continue
      const source = this.context.createBufferSource()
      source.buffer = buffer
      source.connect(this.destination)
      source.onended = () => this.sources.delete(source)
      this.sources.add(source)
      source.start(this.nextTime)
      this.nextTime += buffer.duration
    }
  }

  private stopSources(): void {
    for (const source of this.sources) {
      try {
        source.stop()
      } catch {
        /* already stopped */
      }
    }
    this.sources.clear()
    this.pending.length = 0
    this.pendingSamples = 0
  }

  private fail(detail: string): void {
    if (this.ended) return
    this.ended = true
    sessions.delete(this.stream)
    this.status?.set({ phase: 'error', detail })
    this.stopSources()
    try {
      this.ws?.close()
    } catch {
      /* ignore */
    }
    this.ws = undefined
    this.scheduleClose()
  }

  /** Host ended the session or the official plugin stopped the track. */
  dispose(): void {
    if (this.ended) {
      this.scheduleClose()
      return
    }
    this.ended = true
    sessions.delete(this.stream)
    if (this.reconnectTimer !== undefined) window.clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
    if (this.ws?.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify({ type: 'stop', draft: true }))
      } catch {
        /* ignore */
      }
    }
    try {
      this.ws?.close()
    } catch {
      /* ignore */
    }
    this.ws = undefined
    this.stopSources()
    if (this.status?.get().phase !== 'error') this.status?.set({ phase: 'done', detail: '已完成' })
    this.scheduleClose()
  }

  private scheduleClose(): void {
    if (typeof document !== 'undefined') document.removeEventListener('pointerdown', this.resumeOnGesture)
    window.setTimeout(() => {
      void this.context.close().catch(() => undefined)
    }, 400)
  }
}

function createSession(status: VoiceState | undefined, url: string): VirtualMicSession {
  const context = new AudioContext({ latencyHint: 'interactive' })
  const destination = context.createMediaStreamDestination()
  const session = new VirtualMicSession(context, destination, status, url)
  sessions.set(session.stream, { stream: session.stream, session })
  return session
}

function seedPreference(): void {
  try {
    const raw = localStorage.getItem(VOICE_PREFERENCE_KEY)
    if (raw === null) {
      localStorage.setItem(VOICE_PREFERENCE_KEY, JSON.stringify({ id: VIRTUAL_DEVICE_ID, label: VIRTUAL_DEVICE_LABEL }))
      return
    }
    const parsed = JSON.parse(raw) as { id?: unknown }
    if (parsed === null || typeof parsed !== 'object' || parsed.id === '' || parsed.id === undefined) {
      localStorage.setItem(VOICE_PREFERENCE_KEY, JSON.stringify({ id: VIRTUAL_DEVICE_ID, label: VIRTUAL_DEVICE_LABEL }))
    }
  } catch {
    /* private mode / unavailable storage */
  }
}

/**
 * Install the device-list and acquisition patches. Returns an idempotent
 * disposer that restores every prototype method and releases live sessions.
 */
export function installVirtualMicrophone(options: VirtualMicOptions = {}): () => void {
  if (typeof navigator === 'undefined' || navigator.mediaDevices === undefined) return () => undefined
  const media = navigator.mediaDevices
  const prototype = Object.getPrototypeOf(media) as MediaDevices
  const originalEnumerate = prototype.enumerateDevices
  const originalGetUserMedia = prototype.getUserMedia
  if (typeof originalEnumerate !== 'function' || typeof originalGetUserMedia !== 'function') return () => undefined

  const url = audioUrl(options)
  seedPreference()

  prototype.enumerateDevices = async function enumerateDevices(this: MediaDevices): Promise<MediaDeviceInfo[]> {
    const devices = await originalEnumerate.call(this)
    if (devices.some((device) => device.deviceId === VIRTUAL_DEVICE_ID)) return devices
    const virtual = {
      deviceId: VIRTUAL_DEVICE_ID,
      groupId: VIRTUAL_DEVICE_ID,
      kind: 'audioinput',
      label: VIRTUAL_DEVICE_LABEL,
      toJSON() {
        return { deviceId: VIRTUAL_DEVICE_ID, groupId: VIRTUAL_DEVICE_ID, kind: 'audioinput', label: VIRTUAL_DEVICE_LABEL }
      }
    } as MediaDeviceInfo
    return [...devices, virtual]
  }

  prototype.getUserMedia = async function getUserMedia(this: MediaDevices, constraints?: MediaStreamConstraints): Promise<MediaStream> {
    if (isVirtualConstraints(constraints)) {
      const session = createSession(options.status, url)
      /* The official plugin may call getUserMedia for a settings preview; capture starts on MediaRecorder.start. */
      return session.stream
    }
    return originalGetUserMedia.call(this, constraints)
  }

  const recorderPrototype = typeof MediaRecorder === 'undefined' ? undefined : MediaRecorder.prototype
  const originalStart = recorderPrototype?.start
  if (recorderPrototype !== undefined && typeof originalStart === 'function') {
    recorderPrototype.start = function start(this: MediaRecorder, ...args: [] | [number]): void {
      try {
        const entry = sessions.get(this.stream)
        entry?.session.begin()
      } catch {
        /* never break the official recorder */
      }
      return originalStart.apply(this, args)
    }
  }

  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    prototype.enumerateDevices = originalEnumerate
    prototype.getUserMedia = originalGetUserMedia
    if (recorderPrototype !== undefined && typeof originalStart === 'function') recorderPrototype.start = originalStart
    for (const entry of [...sessions.values()]) {
      sessions.delete(entry.stream)
      entry.session.dispose()
    }
  }
}

/** Test/telemetry helper: number of live synthetic streams. */
export function virtualMicSessionCount(): number {
  return sessions.size
}
