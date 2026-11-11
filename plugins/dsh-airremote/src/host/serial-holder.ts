/**
 * 串口互斥的「统一持有者」。
 *
 * 同一个 COM 口不能同时被浏览器 Web Serial 烧录和 host 侧的时间同步占用，
 * 但这两件事分属两个执行环境（浏览器 / Node），所以由 host 出一份共享状态：
 *
 *  - `flash`：前端点了「烧录」，在打开串口前先 POST `/airremote/serial-hold`
 *    抢锁；烧完（或用户取消）再放锁。
 *  - `sync` ：host 自己的 `POST /airremote/sync-time` 抢锁，写完时间立刻放。
 *
 * 5 分钟没有任何心跳就自动过期，避免浏览器崩掉把口永久占住。
 * 这里只记状态，不碰串口：不打开、不枚举、不留定时器（过期是在读写时惰性判断的）。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

/** 谁持有串口。`none` 表示空闲。 */
export type SerialHolderName = 'none' | 'flash' | 'sync'

/** 真正能「持有」的两方；`none` 只是一种请求值。 */
export type SerialLockName = Exclude<SerialHolderName, 'none'>

export interface SerialHolderState {
  holder: SerialHolderName
  /** 抢锁的 ISO 时间；空闲时为 null。 */
  since: string | null
}

export interface SerialHolderOptions {
  /** 自动过期时间，默认 5 分钟。测试可以调小。 */
  ttlMs?: number
  /** 时钟注入，默认 `Date.now`。 */
  now?: () => number
}

/** 默认 5 分钟自动过期。 */
export const SERIAL_HOLDER_TTL_MS = 5 * 60 * 1000

/** 请求体上限，和 `time-routes.ts` 保持一致。 */
const MAX_BODY_BYTES = 4096

export class SerialHolder {
  private readonly ttlMs: number
  private readonly now: () => number
  private holder: SerialLockName | null = null
  private sinceMs: number | null = null

  constructor(options: SerialHolderOptions = {}) {
    this.ttlMs = options.ttlMs ?? SERIAL_HOLDER_TTL_MS
    this.now = options.now ?? Date.now
  }

  /** 当前状态（顺便处理过期）。 */
  state(): SerialHolderState {
    this.expire()
    return this.holder === null
      ? { holder: 'none', since: null }
      : { holder: this.holder, since: new Date(this.sinceMs ?? this.now()).toISOString() }
  }

  /** 抢锁：空闲（或已过期）时成功；已被别人持有则失败。重复抢同一把锁算成功（幂等，`since` 不刷新）。 */
  acquire(holder: SerialLockName): boolean {
    this.expire()
    if (this.holder === null) {
      this.holder = holder
      this.sinceMs = this.now()
      return true
    }
    return this.holder === holder
  }

  /**
   * 放锁：只放自己持有的那把；`'none'` 表示强制清空（前端「取消烧录」兜底）。
   * 返回是否真的清空了。
   */
  release(holder: SerialHolderName): boolean {
    this.expire()
    if (this.holder === null) return true
    if (holder !== 'none' && this.holder !== holder) return false
    this.holder = null
    this.sinceMs = null
    return true
  }

  private expire(): void {
    if (this.holder === null || this.sinceMs === null) return
    if (this.now() - this.sinceMs < this.ttlMs) return
    this.holder = null
    this.sinceMs = null
  }
}

/* ------------------------------------------------------------------ *
 * `/airremote/serial-state` + `/airremote/serial-hold`
 * ------------------------------------------------------------------ */

export interface SerialRouteOptions {
  holder: SerialHolder
  /** 正常事件（抢到 / 放掉锁）。 */
  log?: (message: string) => void
  /** 异常事件；不抛错，只记录。 */
  warn?: (message: string) => void
}

/**
 * 两条串口锁路由的处理体。`webServer.register` 只按路径匹配、不看方法，
 * 所以每个 handler 自己按 `req.method` 分发。
 */
export class SerialRoutes {
  private readonly options: SerialRouteOptions

  constructor(options: SerialRouteOptions) {
    this.options = options
  }

  /** `GET /airremote/serial-state` → `{ok:true, holder, since}`。 */
  readonly stateHandler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!originAllowed(req)) {
      rejectForeignOrigin(res)
      return
    }
    const method = (req.method ?? 'GET').toUpperCase()
    if (method !== 'GET' && method !== 'HEAD') {
      sendJson(res, 405, { ok: false, error: 'bad-request', message: '只支持 GET' })
      return
    }
    sendJson(res, 200, { ok: true, ...this.options.holder.state() }, method === 'HEAD')
  }

  /** `POST /airremote/serial-hold` body `{"holder":"flash"|"none"}`：抢锁 / 放锁。 */
  readonly holdHandler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!originAllowed(req)) {
      rejectForeignOrigin(res)
      return
    }
    if ((req.method ?? 'GET').toUpperCase() !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'bad-request', message: '只支持 POST' })
      return
    }

    let body: unknown
    try {
      body = await readJsonBody(req)
    } catch (error) {
      sendJson(res, 400, {
        ok: false,
        error: 'bad-request',
        message: error instanceof Error ? error.message : '请求体不合法'
      })
      return
    }
    const requested = body !== null && typeof body === 'object' ? (body as { holder?: unknown }).holder : undefined
    if (requested !== 'flash' && requested !== 'none' && requested !== 'sync') {
      sendJson(res, 400, { ok: false, error: 'bad-request', message: 'holder 必须是 "flash"、"sync" 或 "none"' })
      return
    }

    if (requested === 'none') {
      this.options.holder.release('none')
      this.options.log?.('airremote: 串口锁已由前端释放')
      sendJson(res, 200, { ok: true, ...this.options.holder.state() })
      return
    }

    if (!this.options.holder.acquire(requested)) {
      sendJson(res, 200, {
        ok: false,
        error: 'busy',
        ...this.options.holder.state(),
        message: '串口正被其它操作占用，请稍后再试'
      })
      return
    }
    this.options.log?.(`airremote: 串口锁已交给 ${requested}`)
    sendJson(res, 200, { ok: true, ...this.options.holder.state() })
  }
}

/**
 * 与 `time-routes.ts` 完全相同的同源策略：页面请求会带 Origin，必须和 Host 一致；
 * `dsh-app:` / `file:` 是桌面壳，Node 客户端（测试）不带 Origin，都放行。
 */
function originAllowed(req: IncomingMessage): boolean {
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

function rejectForeignOrigin(res: ServerResponse): void {
  sendJson(res, 403, { ok: false, error: 'forbidden', message: '跨站请求被拒绝（Origin 与 Host 不一致）' })
}

function sendJson(res: ServerResponse, status: number, body: unknown, headOnly = false): void {
  if (res.headersSent || res.writableEnded) return
  const payload = `${JSON.stringify(body)}\n`
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store'
  })
  res.end(headOnly ? undefined : payload)
}

/** 读 JSON 请求体：上限 4 KB，空体或非法 JSON 抛错。 */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new Error('请求体超过 4 KB')
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') throw new Error('请求体为空，需要 JSON')
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new Error('请求体不是合法 JSON')
  }
}
