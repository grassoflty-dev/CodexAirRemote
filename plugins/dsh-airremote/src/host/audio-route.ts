/**
 * `/airremote/audio` upgrade route.
 *
 * The browser shim connects here, sends `{type:"start"}` when the official
 * voice-input plugin constructs its MediaRecorder, and receives the board's
 * 16 kHz mono PCM as binary frames. Control/state messages are JSON text.
 */

import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { BoardDiscovery } from './discovery.js'
import { BoardSession, type BoardEndReason, type BoardState, type SimulationTarget } from './board-session.js'
import { acceptWebSocket, type WsConnection } from './ws.js'
import type { AirRemoteHostConfig } from './config.js'

export interface AudioRouteOptions {
  config: AirRemoteHostConfig
  discovery?: BoardDiscovery
  simulation?: SimulationTarget
  logger?: (message: string) => void
}

interface ActiveSession {
  connection: WsConnection
  session: BoardSession
  lastSeen: number
  heartbeat: NodeJS.Timeout
}

type BrowserMessage =
  | { type: 'start' }
  | { type: 'stop'; draft?: boolean }
  | { type: 'ping' }
  | { type: string; [key: string]: unknown }

export class AudioRoute {
  private active: ActiveSession | undefined
  private disposed = false
  private readonly options: AudioRouteOptions

  constructor(options: AudioRouteOptions) {
    this.options = options
  }

  /** `webServer.registerUpgrade` handler. */
  readonly handler = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    if (this.disposed) {
      socket.destroy()
      return
    }
    if (!this.originAllowed(req)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
      socket.destroy()
      return
    }
    if (this.active !== undefined) {
      const rejected = acceptWebSocket(req, socket, head, {})
      rejected.sendText(JSON.stringify({ type: 'busy', detail: '另一个页面正在使用 Air Remote' }))
      rejected.close(1008, 'busy')
      return
    }
    let connection: WsConnection | undefined
    const active: ActiveSession = {
      connection: undefined as unknown as WsConnection,
      session: undefined as unknown as BoardSession,
      lastSeen: Date.now(),
      heartbeat: setInterval(() => undefined, 60_000)
    }
    connection = acceptWebSocket(req, socket, head, {
      onMessage: (message) => {
        active.lastSeen = Date.now()
        if (message.type === 'binary') return
        let parsed: BrowserMessage
        try {
          parsed = JSON.parse(message.text) as BrowserMessage
        } catch {
          return
        }
        if (parsed.type === 'start') {
          this.start(active, parsed)
        } else if (parsed.type === 'stop') {
          const draft = (parsed as { draft?: boolean }).draft !== false
          void this.active?.session.stop({ draft })
        } else if (parsed.type === 'ping') {
          connection?.sendText(JSON.stringify({ type: 'pong', at: Date.now() }))
        }
      },
      onClose: () => {
        if (this.active === active) {
          const session = active.session
          this.active = undefined
          void session?.stop({ draft: false })
        }
      },
      onError: (error) => {
        this.options.logger?.(`airremote: browser socket error: ${error.message}`)
      }
    })
    active.connection = connection
    clearInterval(active.heartbeat)
    active.heartbeat = setInterval(() => {
      if (Date.now() - active.lastSeen > 45_000) {
        connection?.close(1001, 'idle')
        return
      }
      connection?.sendText(JSON.stringify({ type: 'ping', at: Date.now() }))
    }, 15_000)
    active.heartbeat.unref?.()
    this.active = active
    this.sendJson(connection, {
      type: 'hello',
      device: 'Air Remote (ESP32-C6)',
      simulate: this.options.simulation !== undefined
    })
  }

  /**
   * The route lives on the local DSH web server, whose upgrade path is outside
   * the page's cookie fence. Refuse cross-site WebSocket handshakes so another
   * local origin cannot open the board microphone; Node clients (tests) send no
   * Origin and are allowed.
   */
  private originAllowed(req: IncomingMessage): boolean {
    const origin = req.headers.origin
    if (typeof origin !== 'string' || origin === '') return true
    try {
      const parsed = new URL(origin)
      if (parsed.protocol === 'dsh-app:' || parsed.protocol === 'file:') return true
      return parsed.host === req.headers.host
    } catch {
      return false
    }
  }

  private start(active: ActiveSession, _message: BrowserMessage): void {
    if (active.session !== undefined) return
    const events = {
      onState: (state: BoardState, detail: string) => {
        this.sendJson(active.connection, { type: 'state', state, detail })
      },
      onPcm: (pcm: Buffer, sequence: number) => {
        active.connection.sendBinary(pcm)
        if (sequence % 50 === 0) {
          this.options.logger?.(`airremote: forwarded ${String(sequence)} audio frames`)
        }
      },
      onEnd: (reason: BoardEndReason, detail: string) => {
        this.sendJson(active.connection, { type: 'ended', reason, detail })
        if (this.active === active) this.active = undefined
        clearInterval(active.heartbeat)
      }
    }
    const session = new BoardSession({
      config: this.options.config,
      discovery: this.options.discovery,
      simulation: this.options.simulation,
      events
    })
    active.session = session
    void session.start()
  }

  private sendJson(connection: WsConnection | undefined, value: unknown): void {
    try {
      connection?.sendText(JSON.stringify(value))
    } catch {
      /* the peer may be gone */
    }
  }

  dispose(): void {
    this.disposed = true
    const active = this.active
    this.active = undefined
    if (active !== undefined) {
      clearInterval(active.heartbeat)
      void active.session?.stop({ draft: false })
      active.connection.close(1001, 'plugin disposed')
    }
  }
}
