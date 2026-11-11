/**
 * One board voice session: discover, AUTH, CAPTURE, then pull PCM frames until
 * the browser stops. The protocol is strictly request/response because the
 * firmware's `send_audio` drains its ring only when it receives `PULL`.
 */

import { existsSync, readFileSync } from 'node:fs'
import { BoardDiscovery } from './discovery.js'
import { authMessage, parseAudioFrame, ABORT, ACK, CANCEL, CAPTURE, CANCELLED, DRAFTED, GO, PULL, READY2, SEND, WAIT } from './protocol.js'
import { connectWebSocket, type WsConnection } from './ws.js'
import type { AirRemoteHostConfig } from './config.js'

export type BoardState =
  | 'discovering'
  | 'connecting'
  | 'authenticating'
  | 'arming'
  | 'live'
  | 'finishing'
  | 'ended'
  | 'error'

export type BoardEndReason = 'draft' | 'cancelled' | 'error' | 'timeout' | 'closed'

export interface BoardSessionEvents {
  onState?: (state: BoardState, detail: string) => void
  onPcm?: (pcm: Buffer, sequence: number) => void
  onEnd?: (reason: BoardEndReason, detail: string) => void
}

export interface SimulationTarget {
  host: string
  port: number
}

export interface BoardSessionOptions {
  config: AirRemoteHostConfig
  discovery?: BoardDiscovery
  simulation?: SimulationTarget
  events?: BoardSessionEvents
}

const AUTH_TIMEOUT_MS = 6000
const GO_TIMEOUT_MS = 6000
const FIRST_AUDIO_TIMEOUT_MS = 12_000
const PULL_TIMEOUT_MS = 1500
const ACK_TIMEOUT_MS = 2500
const MAX_SESSION_MS = 65_000

export class BoardSession {
  private ws: WsConnection | undefined
  private state: BoardState = 'discovering'
  private readonly events: BoardSessionEvents
  private readonly config: AirRemoteHostConfig
  private readonly discovery: BoardDiscovery | undefined
  private readonly simulation: SimulationTarget | undefined
  private ended = false
  private captureComplete = false
  private terminalSent = false
  private pullOutstanding = false
  private sequenceSeen = 0
  private stopRequested: { draft: boolean } | undefined

  private authTimer: NodeJS.Timeout | undefined
  private goTimer: NodeJS.Timeout | undefined
  private firstAudioTimer: NodeJS.Timeout | undefined
  private pullTimer: NodeJS.Timeout | undefined
  private pullTimeout: NodeJS.Timeout | undefined
  private ackTimer: NodeJS.Timeout | undefined
  private maxTimer: NodeJS.Timeout | undefined
  private endResolve: ((reason: BoardEndReason, detail: string) => void) | undefined
  private readonly endPromise: Promise<{ reason: BoardEndReason; detail: string }>

  constructor(options: BoardSessionOptions) {
    this.config = options.config
    this.discovery = options.discovery
    this.simulation = options.simulation
    this.events = options.events ?? {}
    this.endPromise = new Promise((resolve) => {
      this.endResolve = (reason, detail) => resolve({ reason, detail })
    })
  }

  /** Resolves when the session ends, for either side's reason. */
  get finished(): Promise<{ reason: BoardEndReason; detail: string }> {
    return this.endPromise
  }

  get currentState(): BoardState {
    return this.state
  }

  private setState(state: BoardState, detail: string): void {
    this.state = state
    this.events.onState?.(state, detail)
  }

  async start(): Promise<void> {
    try {
      const target = await this.resolveTarget()
      this.setState('connecting', `连接 ${target.host}:${String(target.port)}…`)
      const token = this.config.pairingToken
      if (token.length !== 64) {
        throw new Error('airremote: pairing token missing; put the firmware token in ~/.dsh/airremote/pairing.txt')
      }
      const ca = this.loadCa()
      const tls = this.simulation === undefined && !this.config.simulate
        ? {
            ca,
            servername: ca === undefined ? undefined : 'airremote.local',
            rejectUnauthorized: ca !== undefined
          }
        : undefined
      const ws = await connectWebSocket(
        {
          host: target.host,
          port: target.port,
          path: '/voice',
          timeoutMs: 10_000,
          tls
        },
        {
          onMessage: (message) => this.onMessage(message),
          onClose: (code, reason) => this.finish('closed', `board socket closed (${String(code)} ${reason})`),
          onError: (error) => this.finish('error', error.message)
        }
      )
      this.ws = ws
      this.setState('authenticating', '已连接，正在认证…')
      ws.sendText(authMessage(token))
      this.authTimer = this.timeout(AUTH_TIMEOUT_MS, () => this.finish('error', '板子未回复 READY2（认证超时）'))
    } catch (error) {
      this.finish('error', error instanceof Error ? error.message : String(error))
    }
  }

  private async resolveTarget(): Promise<SimulationTarget> {
    if (this.simulation !== undefined) return this.simulation
    if (this.config.boardHost !== '') return { host: this.config.boardHost, port: this.config.boardPort }
    if (this.discovery === undefined) throw new Error('airremote: no discovery service and no boardHost configured')
    this.setState('discovering', '等待开发板（请在板子上点 Voice）…')
    const board = await this.discovery.wait(this.config.discoveryTimeoutMs)
    return { host: board.host, port: this.config.boardPort }
  }

  private loadCa(): string | undefined {
    try {
      if (existsSync(this.config.caFile)) {
        const text = readFileSync(this.config.caFile, 'utf8').trim()
        if (text.includes('BEGIN CERTIFICATE')) return text
      }
    } catch {
      /* fall back to an unverified connection */
    }
    return undefined
  }

  private timeout(ms: number, callback: () => void): NodeJS.Timeout {
    const timer = setTimeout(callback, ms)
    timer.unref?.()
    return timer
  }

  private clearTimers(): void {
    for (const timer of [this.authTimer, this.goTimer, this.firstAudioTimer, this.pullTimer, this.pullTimeout, this.ackTimer, this.maxTimer]) {
      if (timer !== undefined) clearTimeout(timer)
    }
    this.authTimer = undefined
    this.goTimer = undefined
    this.firstAudioTimer = undefined
    this.pullTimer = undefined
    this.pullTimeout = undefined
    this.ackTimer = undefined
    this.maxTimer = undefined
  }

  private onMessage(message: { type: 'text'; text: string } | { type: 'binary'; data: Buffer }): void {
    if (this.ended) return
    if (message.type === 'binary') {
      this.pullOutstanding = false
      if (this.pullTimeout !== undefined) clearTimeout(this.pullTimeout)
      this.pullTimeout = undefined
      if (this.firstAudioTimer !== undefined) clearTimeout(this.firstAudioTimer)
      this.firstAudioTimer = undefined
      const frame = parseAudioFrame(message.data)
      if (frame === undefined) return
      this.sequenceSeen = frame.sequence
      this.events.onPcm?.(frame.pcm, frame.sequence)
      this.schedulePull(0)
      return
    }
    const text = message.text.trim()
    if (text === READY2) {
      if (this.authTimer !== undefined) clearTimeout(this.authTimer)
      this.authTimer = undefined
      this.setState('arming', '认证通过，请求录音…')
      this.ws?.sendText(CAPTURE)
      this.goTimer = this.timeout(GO_TIMEOUT_MS, () => this.finish('error', '板子未回复 GO（录音启动超时）'))
      return
    }
    if (text === GO) {
      if (this.goTimer !== undefined) clearTimeout(this.goTimer)
      this.goTimer = undefined
      this.setState('live', '录音中')
      this.firstAudioTimer = this.timeout(FIRST_AUDIO_TIMEOUT_MS, () =>
        this.finish('error', '板子已开始录音但 12 秒内没有音频帧')
      )
      this.maxTimer = this.timeout(MAX_SESSION_MS, () => {
        this.setState('finishing', '达到单次录音上限，正在收尾…')
        this.stop({ draft: true }).catch(() => undefined)
      })
      this.schedulePull(0)
      return
    }
    if (text === WAIT) {
      this.pullOutstanding = false
      if (this.pullTimeout !== undefined) clearTimeout(this.pullTimeout)
      this.pullTimeout = undefined
      this.schedulePull(8)
      return
    }
    if (text === SEND) {
      this.captureComplete = true
      if (this.pullTimeout !== undefined) clearTimeout(this.pullTimeout)
      this.pullTimeout = undefined
      this.setState('finishing', '板子录音结束，等待 DSH 停止…')
      return
    }
    if (text === CANCEL) {
      this.captureComplete = true
      this.stopRequested = { draft: false }
      this.setState('finishing', '板子已取消')
      if (!this.terminalSent) {
        this.terminalSent = true
        this.ws?.sendText(CANCELLED)
      }
      this.ackTimer = this.timeout(ACK_TIMEOUT_MS, () => this.finish('cancelled', '已取消'))
      return
    }
    if (text === ACK) {
      if (this.ackTimer !== undefined) clearTimeout(this.ackTimer)
      this.ackTimer = undefined
      this.finish(this.stopRequested?.draft === false ? 'cancelled' : 'draft', '会话结束')
      return
    }
  }

  private schedulePull(delayMs: number): void {
    if (this.ended || this.captureComplete) return
    if (this.pullTimer !== undefined) clearTimeout(this.pullTimer)
    this.pullTimer = this.timeout(delayMs, () => {
      this.pullTimer = undefined
      this.pull()
    })
  }

  private pull(): void {
    if (this.ended || this.captureComplete || this.ws === undefined || !this.ws.open) return
    if (this.pullOutstanding) return
    this.pullOutstanding = true
    this.ws.sendText(PULL)
    if (this.pullTimeout !== undefined) clearTimeout(this.pullTimeout)
    this.pullTimeout = this.timeout(PULL_TIMEOUT_MS, () => {
      this.pullOutstanding = false
      if (this.ended) return
      if (this.state === 'live') this.schedulePull(0)
    })
  }

  /** Ask the board to stop; resolves once the session has ended. */
  async stop(options: { draft: boolean } = { draft: true }): Promise<void> {
    if (this.ended) return
    this.stopRequested = options
    this.clearTimers()
    this.setState('finishing', options.draft ? '正在结束板子录音…' : '正在取消…')
    if (this.ws === undefined || !this.ws.open) {
      this.finish(options.draft ? 'draft' : 'cancelled', '连接已关闭')
      return
    }
    if (this.captureComplete) {
      if (!this.terminalSent) {
        this.terminalSent = true
        this.ws.sendText(options.draft ? DRAFTED : CANCELLED)
      }
    } else {
      this.ws.sendText(ABORT)
    }
    this.ackTimer = this.timeout(ACK_TIMEOUT_MS, () => {
      this.finish(options.draft ? 'draft' : 'cancelled', '板子未回复 ACK，按本地结束处理')
    })
    await this.finished
  }

  private finish(reason: BoardEndReason, detail: string): void {
    if (this.ended) return
    this.ended = true
    this.clearTimers()
    this.setState(reason === 'error' || reason === 'timeout' ? 'error' : 'ended', detail)
    try {
      this.ws?.close(1000, reason)
    } catch {
      /* ignore */
    }
    this.ws = undefined
    this.events.onEnd?.(reason, detail)
    this.endResolve?.(reason, detail)
  }

  get lastSequence(): number {
    return this.sequenceSeen
  }
}
