/**
 * `/airremote/flash` upgrade route：浏览器点「烧录」→ host 用 esptool-js 烧内置固件。
 *
 * 协议（客户端按这个写，改之前先对齐）：
 *
 *   连接建立（可以同时有多条）→
 *     服务端立刻发 `{"type":"state","phase":"idle"|"running"}`
 *     （`running` = 已有烧录任务在跑，这条连接只是观察者）
 *
 *   客户端 → 服务端：`{"type":"start"}`、`{"type":"cancel"}`（也接受 `{"type":"ping"}`）
 *
 *   服务端 → 所有连接（广播）：
 *     `{"type":"state","phase":"running"|"done"|"error"|"cancelled"}`
 *     `{"type":"log","line":"<esptool 原始行>"}`
 *     `{"type":"progress","percent":0-100,"written":N,"total":N}`
 *     `{"type":"done","port":"COM7","seconds":12.3}`
 *     `{"type":"error","code":"<错误码>","message":"<中文>"}`
 *     `{"type":"ping","at":<epoch ms>}`（每 15s，仅保活）
 *
 * 多连接语义（为什么不再「单会话 + busy 断开」）：
 *  - 设置页一挂载就连 WS 并一直留着，如果把「已有连接」当忙碌，任何外部/脚本连接
 *    都会恒回 busy，且服务端 45s 空闲 close(1001,'idle') 会让页面显示「已断开」。
 *  - 因此允许多条连接并存，每条都能连/断、都能观察状态、都能发 `cancel`。
 *  - 只有**烧录任务**独占：已有任务在跑时再收到 `start`，只回
 *    `{"type":"error","code":"busy","message":"已有一次烧录在进行，请等它结束"}`，**不关闭连接**。
 *  - `log`/`progress`/`state`/`done`/`error` 广播给所有连接，中途连上来的也能看进度。
 *  - 心跳每 15s 发一条 `ping` 只为保持链路活跃，**不因客户端空闲而断开**；
 *    连接自己断了由 socket 的 close 事件自然移除。
 *
 * 与 `audio-route.ts` 一致：同源检查（`originAllowed`）。
 * **任务结束 / 取消 / 失败后串口与 `SerialHolder` 的释放顺序仍由 `flash-service.ts`
 * 的 finally 保证**，这里只在任务收尾时把任务槽清空并放锁。
 */

import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { flashFirmware, FlashError } from './flash-service.js'
import { isSameOriginRequest } from './origin.js'
import { findBoardPort } from './serial-port.js'
import type { SerialHolder } from './serial-holder.js'
import { acceptWebSocket, type WsConnection } from './ws.js'

/** 心跳间隔：只发 `ping` 保活，不据此判定 / 断开空闲连接。 */
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

/** 一条浏览器连接。`connection` 在 `acceptWebSocket` 返回后才赋值，消息回调里只读。 */
interface ClientConnection {
  connection: WsConnection
}

/** 正在跑的烧录任务。存在即表示「串口被烧录独占」。 */
interface FlashTask {
  controller: AbortController
}

type ClientMessage = { type?: unknown; [key: string]: unknown }

export class FlashRoute {
  /** 所有活着的连接；连/断都只动这个集合。 */
  private readonly clients = new Set<WsConnection>()
  /** 当前烧录任务；`undefined` = 空闲。只有它会产生「忙碌」。 */
  private task: FlashTask | undefined
  private heartbeat: NodeJS.Timeout | undefined
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
    if (!isSameOriginRequest(req, this.options.warn)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
      socket.destroy()
      return
    }

    const client: ClientConnection = { connection: undefined as unknown as WsConnection }
    const connection = acceptWebSocket(req, socket, head, {
      onMessage: (message) => {
        if (message.type === 'binary') return
        let parsed: ClientMessage
        try {
          parsed = JSON.parse(message.text) as ClientMessage
        } catch {
          return
        }
        if (parsed.type === 'start') {
          this.start(client)
        } else if (parsed.type === 'cancel') {
          this.cancel(client, '客户端请求取消')
        } else if (parsed.type === 'ping') {
          this.sendJson(client.connection, { type: 'pong', at: Date.now() })
        }
      },
      onClose: () => {
        // 单条连接断开只是「少了一个观察者」：不取消别人的烧录，连接自然移除。
        if (client.connection !== undefined) this.clients.delete(client.connection)
        if (this.clients.size === 0) this.stopHeartbeat()
      },
      onError: (error) => {
        this.options.warn?.(`airremote: flash socket error: ${error.message}`)
      }
    })

    client.connection = connection
    this.clients.add(connection)
    /* 诊断：记录实际握手来源，便于对照浏览器页面的 carrier/base 报错。 */
    this.options.logger?.(
      `airremote: flash socket accepted (origin=${req.headers.origin ?? 'none'}, host=${req.headers.host ?? 'none'})`
    )
    this.ensureHeartbeat()

    // 新连接先拿当前状态：空闲就是 idle；有任务在跑则告诉它 running，后续事件继续广播。
    this.sendJson(connection, { type: 'state', phase: this.task === undefined ? 'idle' : 'running' })
  }

  /** 只在有连接时开一个 interval；只发 ping，不因空闲关闭。 */
  private ensureHeartbeat(): void {
    if (this.heartbeat !== undefined) return
    this.heartbeat = setInterval(() => this.heartbeatTick(), HEARTBEAT_INTERVAL_MS)
    this.heartbeat.unref?.()
  }

  private stopHeartbeat(): void {
    if (this.heartbeat === undefined) return
    clearInterval(this.heartbeat)
    this.heartbeat = undefined
  }

  private heartbeatTick(): void {
    if (this.disposed || this.clients.size === 0) {
      this.stopHeartbeat()
      return
    }
    this.broadcast({ type: 'ping', at: Date.now() })
  }

  /** 发起一次烧录；已有任务时只回 busy 错误，连接保持。 */
  private start(client: ClientConnection): void {
    if (this.disposed) return

    if (this.task !== undefined) {
      this.sendJson(client.connection, {
        type: 'error',
        code: 'busy',
        message: '已有一次烧录在进行，请等它结束'
      })
      return
    }

    const holder = this.options.holder
    if (holder !== undefined && !holder.acquire('flash')) {
      this.sendJson(client.connection, { type: 'state', phase: 'error' })
      this.sendJson(client.connection, { type: 'error', code: 'busy', message: '串口正被其它操作占用，请稍后再试' })
      return
    }
    const lockHeld = holder !== undefined

    const controller = new AbortController()
    const task: FlashTask = { controller }
    this.task = task
    // 广播 running：所有连接（包括这条请求的连接）都进入「烧录中」。
    this.broadcast({ type: 'state', phase: 'running' })

    const flash = this.options.flash ?? flashFirmware
    void (async () => {
      try {
        const result = await flash({
          firmwareDir: this.options.firmwareDir,
          port: await this.resolvePort(),
          signal: controller.signal,
          onLine: (line) => this.broadcast({ type: 'log', line }),
          onProgress: (percent, written, total) =>
            this.broadcast({ type: 'progress', percent, written, total }),
          onWarn: (message) => this.options.warn?.(message)
        })
        this.broadcast({ type: 'state', phase: 'done' })
        this.broadcast({ type: 'done', port: result.port, seconds: result.seconds })
        this.options.logger?.(`airremote: 固件已烧录到 ${result.port}（${String(result.seconds)}s）`)
      } catch (error) {
        const code = error instanceof FlashError ? error.code : 'internal'
        const message = error instanceof Error ? error.message : String(error)
        if (code === 'cancelled') {
          this.broadcast({ type: 'state', phase: 'cancelled' })
          this.options.logger?.(`airremote: 烧录已取消：${message}`)
        } else {
          this.broadcast({ type: 'state', phase: 'error' })
          this.options.warn?.(`airremote: 烧录失败（${code}）：${message}`)
        }
        this.broadcast({ type: 'error', code, message })
      } finally {
        if (this.task === task) this.task = undefined
        if (lockHeld) holder?.release('flash')
      }
    })()
  }

  /** 任意连接都可以取消；没有任务时只把「空闲」回给发起者。 */
  private cancel(client: ClientConnection, reason: string): void {
    const task = this.task
    if (task === undefined) {
      this.sendJson(client.connection, { type: 'state', phase: 'idle' })
      return
    }
    this.options.logger?.(`airremote: ${reason}`)
    task.controller.abort()
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

  /** 广播给所有连接；顺手清掉已经关掉的。 */
  private broadcast(value: unknown): void {
    for (const connection of this.clients) {
      if (!connection.open) {
        this.clients.delete(connection)
        continue
      }
      this.sendJson(connection, value)
    }
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
    this.stopHeartbeat()
    this.task?.controller.abort()
    const connections = [...this.clients]
    this.clients.clear()
    for (const connection of connections) {
      try {
        connection.close(1001, 'plugin disposed')
      } catch {
        /* 对端可能已经走了 */
      }
    }
  }
}
