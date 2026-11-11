/**
 * 「开发板时间」的 HTTP 路由（contract: `/airremote/time`、`/airremote/sync-time`）。
 *
 * - `GET  /airremote/time`  读保存的时区选择
 * - `POST /airremote/time`  存时区选择
 * - `POST /airremote/sync-time` 用串口把 host 当前时间 + 分钟偏移写给板子
 *
 * 只在有人点击时动作：没有定时器、没有轮询、没有插拔监听。
 * 同一时刻只允许一次同步，第二次直接回 `busy`。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { BoardSyncError, findBoardPort, syncBoardTime, type BoardSyncErrorCode } from './serial-port.js'
import { isTimezoneId, readTimePreference, writeTimePreference } from './time-settings.js'

/** 请求体上限；两个 POST 的载荷都是几十字节，4 KB 足够并挡住放大攻击。 */
const MAX_BODY_BYTES = 4096

/** 与契约一致的分钟偏移范围（东为正，480 = UTC+8）。 */
const MIN_MINUTES = -720
const MAX_MINUTES = 840

export interface TimeRouteOptions {
  /** `resolveHostConfig().dataDir`，`time.json` 放这里。 */
  dataDir: string
  /** 配置里显式指定的串口；空串表示自动发现。 */
  serialPort: string
  /** 正常事件（如一次成功的同步）。 */
  log?: (message: string) => void
  /** 异常事件；不抛错，只记录。 */
  warn?: (message: string) => void
}

class BadRequestError extends Error {}

/**
 * 三条路由的处理体。`webServer.register` 只按路径匹配、不区分方法，
 * 所以 `/airremote/time` 用同一个 handler 内部按 `req.method` 分发
 * （不能对同一路径注册两次：webserver 对重复 (kind, path) 会直接抛错）。
 */
export class TimeRoutes {
  private readonly options: TimeRouteOptions
  /** 同步进行中；第二次请求立即回 `busy`，不排队。 */
  private syncing = false
  private disposed = false

  constructor(options: TimeRouteOptions) {
    this.options = options
  }

  /** `/airremote/time`。 */
  readonly timeHandler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!this.originAllowed(req)) {
      this.rejectForeignOrigin(res)
      return
    }
    const method = (req.method ?? 'GET').toUpperCase()
    if (method === 'GET') {
      this.sendPreference(res)
      return
    }
    if (method === 'POST') {
      await this.savePreference(req, res)
      return
    }
    this.sendJson(res, 405, { ok: false, error: 'bad-request', message: '只支持 GET / POST' })
  }

  /** `/airremote/sync-time`。 */
  readonly syncTimeHandler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!this.originAllowed(req)) {
      this.rejectForeignOrigin(res)
      return
    }
    if ((req.method ?? 'GET').toUpperCase() !== 'POST') {
      this.sendJson(res, 405, { ok: false, error: 'bad-request', message: '只支持 POST' })
      return
    }
    await this.sync(req, res)
  }

  dispose(): void {
    this.disposed = true
  }

  /**
   * 与 `audio-route.ts` 相同的同源策略：页面请求会带 Origin，必须和 Host 一致；
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

  private rejectForeignOrigin(res: ServerResponse): void {
    this.sendJson(res, 403, { ok: false, error: 'forbidden', message: '跨站请求被拒绝（Origin 与 Host 不一致）' })
  }

  private sendPreference(res: ServerResponse): void {
    const preference = readTimePreference(this.options.dataDir)
    this.sendJson(res, 200, { ok: true, timezone: preference.timezone, updatedAt: preference.updatedAt })
  }

  private async savePreference(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: unknown
    try {
      body = await readJsonBody(req)
    } catch (error) {
      this.badRequest(res, error)
      return
    }
    const timezone = body !== null && typeof body === 'object' ? (body as { timezone?: unknown }).timezone : undefined
    if (!isTimezoneId(timezone)) {
      this.sendJson(res, 400, {
        ok: false,
        error: 'bad-request',
        message: 'timezone 必须是 1..32 个 [a-z0-9+_-] 字符的字符串'
      })
      return
    }
    try {
      const saved = writeTimePreference(this.options.dataDir, timezone)
      this.sendJson(res, 200, { ok: true, timezone: saved.timezone, updatedAt: saved.updatedAt })
    } catch (error) {
      this.options.warn?.(`airremote: 保存时区失败：${describe(error)}`)
      this.sendJson(res, 200, { ok: false, error: 'internal', message: `保存时区失败：${describe(error)}` })
    }
  }

  private async sync(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: unknown
    try {
      body = await readJsonBody(req)
    } catch (error) {
      this.badRequest(res, error)
      return
    }
    const raw = body !== null && typeof body === 'object' ? (body as { minutes?: unknown }).minutes : undefined
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < MIN_MINUTES || raw > MAX_MINUTES) {
      this.sendJson(res, 400, {
        ok: false,
        error: 'bad-request',
        message: `minutes 必须是 ${String(MIN_MINUTES)}..${String(MAX_MINUTES)} 之间的整数`
      })
      return
    }
    const minutes = raw

    if (this.disposed) {
      this.sendJson(res, 200, { ok: false, error: 'internal', message: '插件正在卸载，请稍后重试', port: null, lines: [] })
      return
    }
    if (this.syncing) {
      this.sendJson(res, 200, {
        ok: false,
        error: 'busy',
        port: null,
        lines: [],
        message: '已有一次时间同步正在进行，请稍候再试'
      })
      return
    }

    this.syncing = true
    /** host 的时钟，不用浏览器时间。 */
    const unix = Math.floor(Date.now() / 1000)
    let port: string | null = null
    try {
      port = await findBoardPort(this.options.serialPort)
      if (port === null) {
        this.sendJson(res, 200, {
          ok: false,
          error: 'no-board',
          port: null,
          lines: [],
          message: '未找到 ESP32-C6 开发板（USB VID 303A）'
        })
        return
      }
      const result = await syncBoardTime(port, unix, minutes)
      this.options.log?.(`airremote: ${port} 时间已同步 unix=${String(unix)} minutes=${String(minutes)}`)
      this.sendJson(res, 200, { ok: true, port, unix, minutes, lines: result.lines })
    } catch (error) {
      const code: BoardSyncErrorCode = error instanceof BoardSyncError ? error.code : 'internal'
      const lines = error instanceof BoardSyncError ? error.lines : []
      this.options.warn?.(`airremote: ${port ?? '?'} 同步失败（${code}）：${describe(error)}`)
      this.sendJson(res, 200, { ok: false, error: code, port, lines, message: describe(error) })
    } finally {
      this.syncing = false
    }
  }

  private badRequest(res: ServerResponse, error: unknown): void {
    const message = error instanceof BadRequestError ? error.message : '请求体不合法'
    this.sendJson(res, 400, { ok: false, error: 'bad-request', message })
  }

  private sendJson(res: ServerResponse, status: number, body: unknown): void {
    if (res.headersSent || res.writableEnded) return
    const payload = `${JSON.stringify(body)}\n`
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(payload),
      'cache-control': 'no-store'
    })
    res.end(payload)
  }
}

/** 读 JSON 请求体：上限 4 KB，空体或非法 JSON 抛 `bad-request`。 */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new BadRequestError('请求体超过 4 KB')
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') throw new BadRequestError('请求体为空，需要 JSON')
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new BadRequestError('请求体不是合法 JSON')
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
