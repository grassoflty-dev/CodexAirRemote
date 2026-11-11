/**
 * `/airremote/flash` upgrade route：浏览器点「烧录」→ host 用 esptool-js 烧内置固件。
 *
 * 协议（客户端按这个写，改之前先对齐）：
 *
 *   连接建立 →
 *     服务端立刻发 `{"type":"state","phase":"idle"|"busy"}`
 *     已有烧录在跑 → 再发 `{"type":"busy","message":"..."}` 然后 `close(1008)`
 *
 *   客户端 → 服务端：`{"type":"start"}`、`{"type":"cancel"}`（也接受 `{"type":"ping"}`）
 *
 *   服务端 → 客户端：
 *     `{"type":"state","phase":"running"|"done"|"error"|"cancelled"|"idle"}`
 *     `{"type":"log","line":"<esptool 原始行>"}`
 *     `{"type":"progress","percent":0-100,"written":N,"total":N}`
 *     `{"type":"done","port":"COM7","seconds":12.3}`
 *     `{"type":"error","code":"<错误码>","message":"<中文>"}`
 *
 * 与 `audio-route.ts` 一致：单活动会话、同源检查（`originAllowed`）、15s 心跳 +
 * 45s 静默断开。**页面关闭 / 刷新导致 WS 断开时必须取消烧录并释放串口**，
 * 否则 Windows 的独占句柄会把口占到拔插为止。
 */

import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { flashFirmware, FlashError } from './flash-service.js'
import { findBoardPort } from './serial-port.js'
import type { SerialHolder } from './serial-holder.js'
import { acceptWebSocket, type WsConnection } from './ws.js'

/** 多久没有收发就认定死连接（心跳间隔 15s，容忍两次丢包）。 */
const IDLE_TIMEOUT_MS = 45_000
const HEARTBEAT_INTERVAL_MS = 15_000

export interface FlashRouteOptions {
  /** 插件包根下的 `firmware/` 目录（绝对路径）。 */
  firmwareDir: string
  /** 串口互斥：烧录期间持有 `flash`，`/airremote/sync-time` 会回 busy。 */
  holder?: SerialHolder
  /** 目标串口解析（配置优先、其次自动发现）；默认 `findBoardPort('')`。返回 null = 没找到板子。 */
  resolvePort?: () => Promise<string | null>
  logger?: (message: string) => void
  warn?: (message: string) => void
  /** 测试注入：默认用 `flashFirmware`。 */
  flash?: typeof flashFirmware
}

interface ActiveSession {
  connection: WsConnection
  lastSeen: number
  heartbeat: NodeJS.Timeout
  running: boolean
  controller?: AbortController
}

type ClientMessage = { type?: unknown; [key: string]: unknown }

export class FlashRoute {
  private active: ActiveSession | undefined
  private disposed = false
  private readonly options: FlashRouteOptions

  constructor(options: FlashRouteOptions) {
    this.options = options
  }

  /** `webServer.registerUpgrade` handler。 */
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
      this.sendJson(rejected, { type: 'state', phase: 'busy' })
      this.sendJson(rejected, { type: 'busy', message: '已有一次烧录在进行，请等它结束' })
      rejected.close(1008, 'busy')
      return
    }

    const active: ActiveSession = {
      connection: undefined as unknown as WsConnection,
      lastSeen: Date.now(),
      heartbeat: setInterval(() => undefined, HEARTBEAT_INTERVAL_MS),
      running: false
    }
    const connection = acceptWebSocket(req, socket, head, {
      onMessage: (message) => {
        active.lastSeen = Date.now()
        if (message.type === 'binary') return
        let parsed: ClientMessage
        try {
          parsed = JSON.parse(message.text) as ClientMessage
        } catch {
          return
        }
        if (parsed.type === 'start') {
          this.start(active)
        } else if (parsed.type === 'cancel') {
          this.cancel(active, '客户端请求取消')
        } else if (parsed.type === 'ping') {
          this.sendJson(connection, { type: 'pong', at: Date.now() })
        }
      },
      onClose: () => {
        // 页面关闭 / 刷新：烧录必须停，串口必须放（硬要求）。
        if (this.active !== active) return
        if (active.running) {
          this.options.warn?.('airremote: 烧录期间连接断开，取消烧录并释放串口')
          active.controller?.abort()
        }
        this.active = undefined
        clearInterval(active.heartbeat)
      },
      onError: (error) => {
        this.options.warn?.(`airremote: flash socket error: ${error.message}`)
      }
    })

    active.connection = connection
    clearInterval(active.heartbeat)
    active.heartbeat = setInterval(() => this.heartbeat(active), HEARTBEAT_INTERVAL_MS)
    active.heartbeat.unref?.()
    this.active = active

    this.sendJson(connection, { type: 'state', phase: 'idle' })
  }

  /**
   * 与 `audio-route.ts` 完全相同的同源策略：页面请求会带 Origin，必须和 Host 一致；
   * `dsh-app:` / `file:` 是桌面壳，Node 客户端（测试）不带 Origin，都放行。
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

  /** 心跳：太久没有收发就断开，避免死连接一直占着会话。 */
  private heartbeat(active: ActiveSession): void {
    if (this.active !== active) {
      clearInterval(active.heartbeat)
      return
    }
    if (Date.now() - active.lastSeen > IDLE_TIMEOUT_MS) {
      active.connection.close(1001, 'idle')
      return
    }
    this.sendJson(active.connection, { type: 'ping', at: Date.now() })
  }

  private start(active: ActiveSession): void {
    if (active.running) return
    if (this.disposed) return

    const holder = this.options.holder
    if (holder !== undefined && !holder.acquire('flash')) {
      this.sendJson(active.connection, { type: 'state', phase: 'error' })
      this.sendJson(active.connection, { type: 'error', code: 'busy', message: '串口正被其它操作占用，请稍后再试' })
      return
    }
    const lockHeld = holder !== undefined

    const controller = new AbortController()
    active.running = true
    active.controller = controller
    this.sendJson(active.connection, { type: 'state', phase: 'running' })

    const flash = this.options.flash ?? flashFirmware
    void (async () => {
      try {
        const result = await flash({
          firmwareDir: this.options.firmwareDir,
          port: await this.resolvePort(),
          signal: controller.signal,
          onLine: (line) => this.sendJson(active.connection, { type: 'log', line }),
          onProgress: (percent, written, total) =>
            this.sendJson(active.connection, { type: 'progress', percent, written, total }),
          onWarn: (message) => this.options.warn?.(message)
        })
        this.sendJson(active.connection, { type: 'state', phase: 'done' })
        this.sendJson(active.connection, { type: 'done', port: result.port, seconds: result.seconds })
        this.options.logger?.(`airremote: 固件已烧录到 ${result.port}（${String(result.seconds)}s）`)
      } catch (error) {
        const code = error instanceof FlashError ? error.code : 'internal'
        const message = error instanceof Error ? error.message : String(error)
        if (code === 'cancelled') {
          this.sendJson(active.connection, { type: 'state', phase: 'cancelled' })
          this.options.logger?.(`airremote: 烧录已取消：${message}`)
        } else {
          this.sendJson(active.connection, { type: 'state', phase: 'error' })
          this.options.warn?.(`airremote: 烧录失败（${code}）：${message}`)
        }
        this.sendJson(active.connection, { type: 'error', code, message })
      } finally {
        active.running = false
        active.controller = undefined
        if (lockHeld) holder?.release('flash')
      }
    })()
  }

  private cancel(active: ActiveSession, reason: string): void {
    if (!active.running) {
      this.sendJson(active.connection, { type: 'state', phase: 'idle' })
      return
    }
    this.options.logger?.(`airremote: ${reason}`)
    active.controller?.abort()
  }

  /**
   * 烧录目标口：用注入的解析器（index.ts 传配置里的 `serialPort`，为空则自动发现），
   * 默认走 `findBoardPort('')`——与时间同步同一条发现路径。
   */
  private async resolvePort(): Promise<string> {
    const resolver = this.options.resolvePort ?? ((): Promise<string | null> => findBoardPort(''))
    const found = await resolver()
    if (found === null || found.trim() === '') {
      throw new FlashError('no-board', '未找到 ESP32-C6 开发板（USB VID 303A）')
    }
    return found.trim()
  }

  private sendJson(connection: WsConnection | undefined, value: unknown): void {
    try {
      connection?.sendText(JSON.stringify(value))
    } catch {
      /* 对端可能已经走了 */
    }
  }

  dispose(): void {
    this.disposed = true
    const active = this.active
    this.active = undefined
    if (active === undefined) return
    clearInterval(active.heartbeat)
    active.controller?.abort()
    active.connection.close(1001, 'plugin disposed')
  }
}
