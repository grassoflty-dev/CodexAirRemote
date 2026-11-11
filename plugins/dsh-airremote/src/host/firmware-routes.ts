/**
 * 「内置固件」的 HTTP 路由（contract: `/airremote/firmware/manifest`、`/airremote/firmware/image`）。
 *
 * 插件包里带一份从 0x0 整体烧写的合并镜像（`firmware/codex_air_remote-merged.bin`）
 * 和它的描述文件（`firmware/manifest.json`），由 `scripts/bundle-firmware.mjs` 在开发机生成。
 * 浏览器端用 Web Serial 把镜像流式写进板子，host 只负责静态下发：
 *
 *  - `GET /airremote/firmware/manifest` → manifest.json（缺少 / 损坏 → 503）
 *  - `GET /airremote/firmware/image`    → 合并镜像，**流式**读盘（不 readFile 进内存）
 *
 * 这里不碰串口、不调用 idf/esptool、不留定时器。
 */

import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'

/** 合并镜像的文件名（相对 `firmwareDir`）。 */
export const FIRMWARE_IMAGE_FILE = 'codex_air_remote-merged.bin'

/** manifest 的文件名（相对 `firmwareDir`）。 */
export const FIRMWARE_MANIFEST_FILE = 'manifest.json'

/** 与契约一致的 manifest 形状。 */
export interface FirmwareManifest {
  /** 产出这份固件的插件（固定 `dsh-airremote`）。 */
  plugin: string
  /** 目标芯片，如 `esp32c6`。 */
  chip: string
  /** 固件语义版本 `MAJOR.MINOR.PATCH`。 */
  version: string
  /** 构建时的 git 短 hash。 */
  commit: string
  /** 整体烧写偏移，恒为 0。 */
  flashOffset: number
  /** 镜像字节数。 */
  size: number
  /** 镜像 sha256（小写 hex），同时用作 ETag。 */
  sha256: string
  /** 构建时间（ISO 8601）。 */
  builtAt: string
}

export interface FirmwareRouteOptions {
  /** 插件包根下的 `firmware/` 目录（绝对路径）。 */
  firmwareDir: string
  /** 正常事件（如一次成功下发）。 */
  log?: (message: string) => void
  /** 异常事件；不抛错，只记录。 */
  warn?: (message: string) => void
}

interface CachedManifest {
  mtimeMs: number
  size: number
  manifest: FirmwareManifest
}

/** 自检结果里的一条问题（中文，带绝对路径，直接可打日志）。 */
export interface FirmwareProblem {
  /** 缺什么 / 哪里不对。 */
  code: 'manifest-missing' | 'manifest-invalid' | 'image-missing' | 'size-mismatch'
  /** 给人看的中文说明。 */
  message: string
  /** 相关文件绝对路径。 */
  path: string
}

export class FirmwareRoutes {
  private readonly options: FirmwareRouteOptions
  private cached: CachedManifest | undefined

  constructor(options: FirmwareRouteOptions) {
    this.options = options
  }

  /** 合并镜像的绝对路径。 */
  get imagePath(): string {
    return join(this.options.firmwareDir, FIRMWARE_IMAGE_FILE)
  }

  /** manifest 的绝对路径。 */
  get manifestPath(): string {
    return join(this.options.firmwareDir, FIRMWARE_MANIFEST_FILE)
  }

  /** `GET /airremote/firmware/manifest`。 */
  readonly manifestHandler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!this.originAllowed(req)) {
      this.rejectForeignOrigin(res)
      return
    }
    const method = (req.method ?? 'GET').toUpperCase()
    if (method !== 'GET' && method !== 'HEAD') {
      this.sendJson(res, 405, { ok: false, error: 'bad-request', message: '只支持 GET / HEAD' })
      return
    }

    let manifest: FirmwareManifest
    try {
      manifest = await this.readManifest()
    } catch (error) {
      this.options.warn?.(`airremote: 内置固件 manifest 不可用：${describe(error)}`)
      this.sendUnavailable(res, `内置固件 manifest 不可用：${describe(error)}`)
      return
    }
    this.sendJson(res, 200, manifest, method === 'HEAD')
  }

  /** `GET /airremote/firmware/image`；支持 `If-None-Match` → 304。 */
  readonly imageHandler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!this.originAllowed(req)) {
      this.rejectForeignOrigin(res)
      return
    }
    const method = (req.method ?? 'GET').toUpperCase()
    if (method !== 'GET' && method !== 'HEAD') {
      this.sendJson(res, 405, { ok: false, error: 'bad-request', message: '只支持 GET / HEAD' })
      return
    }

    let manifest: FirmwareManifest
    try {
      manifest = await this.readManifest()
    } catch (error) {
      this.options.warn?.(`airremote: 内置固件 manifest 不可用：${describe(error)}`)
      this.sendUnavailable(res, `内置固件 manifest 不可用：${describe(error)}`)
      return
    }

    let size: number
    try {
      size = (await stat(this.imagePath)).size
    } catch (error) {
      this.options.warn?.(`airremote: 内置固件镜像不可读：${describe(error)}`)
      this.sendUnavailable(res, `内置固件镜像不可读：${describe(error)}`)
      return
    }
    if (size !== manifest.size) {
      const message = `内置固件与 manifest 不一致（文件 ${String(size)} 字节 / manifest ${String(manifest.size)} 字节），请重跑 scripts/bundle-firmware.mjs`
      this.options.warn?.(`airremote: ${message}`)
      this.sendUnavailable(res, message)
      return
    }

    const etag = `"${manifest.sha256}"`
    const headers = {
      etag,
      'cache-control': 'no-store',
      'accept-ranges': 'none'
    }
    if (matchesEtag(req.headers['if-none-match'], manifest.sha256)) {
      if (!res.headersSent && !res.writableEnded) res.writeHead(304, headers)
      res.end()
      return
    }

    if (res.headersSent || res.writableEnded) return
    res.writeHead(200, {
      ...headers,
      'content-type': 'application/octet-stream',
      'content-length': size,
      'content-disposition': `attachment; filename="${FIRMWARE_IMAGE_FILE}"`,
      'x-airremote-firmware-version': manifest.version
    })
    if (method === 'HEAD') {
      res.end()
      return
    }

    const stream = createReadStream(this.imagePath)
    /** 客户端提前断开 / 出错都要把读流关掉，不然文件句柄会挂着。 */
    res.on('close', () => {
      stream.destroy()
    })
    stream.on('error', (error) => {
      this.options.warn?.(`airremote: 读取内置固件失败：${describe(error)}`)
      stream.destroy()
      res.destroy(error)
    })
    stream.pipe(res)
  }

  /**
   * 启动自检：manifest 能不能读、bin 在不在、大小对不对。
   * 返回问题列表（空数组 = 一切正常）；**不抛错**，调用方只打日志。
   */
  async selfCheck(): Promise<FirmwareProblem[]> {
    const problems: FirmwareProblem[] = []

    let manifest: FirmwareManifest
    try {
      manifest = await this.readManifest()
    } catch (error) {
      const missing = (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
      problems.push({
        code: missing ? 'manifest-missing' : 'manifest-invalid',
        path: this.manifestPath,
        message: missing
          ? `内置固件缺失：找不到 ${this.manifestPath}，请先在开发机跑 scripts/bundle-firmware.mjs`
          : `内置固件 manifest 损坏：${this.manifestPath}（${describe(error)}）`
      })
      return problems
    }

    try {
      const actual = (await stat(this.imagePath)).size
      if (actual !== manifest.size) {
        problems.push({
          code: 'size-mismatch',
          path: this.imagePath,
          message:
            `内置固件大小与 manifest 不符：${this.imagePath} 是 ${String(actual)} 字节，` +
            `manifest 写的是 ${String(manifest.size)} 字节，请重跑 scripts/bundle-firmware.mjs`
        })
      }
    } catch {
      problems.push({
        code: 'image-missing',
        path: this.imagePath,
        message: `内置固件缺失：找不到 ${this.imagePath}，请先在开发机跑 scripts/bundle-firmware.mjs`
      })
    }
    return problems
  }

  /** 读 manifest：按 mtime+size 缓存，烧录期间会连读两次，不重复解析。 */
  private async readManifest(): Promise<FirmwareManifest> {
    const info = await stat(this.manifestPath)
    const cached = this.cached
    if (cached !== undefined && cached.mtimeMs === info.mtimeMs && cached.size === info.size) {
      return cached.manifest
    }
    const raw = await readFile(this.manifestPath, 'utf8')
    const parsed = JSON.parse(raw) as unknown
    const manifest = normalizeManifest(parsed)
    this.cached = { mtimeMs: info.mtimeMs, size: info.size, manifest }
    this.options.log?.(`airremote: 内置固件 v${manifest.version}（${String(manifest.size)} 字节）`)
    return manifest
  }

  /** 与 `time-routes.ts` 相同的同源策略。 */
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

  private sendUnavailable(res: ServerResponse, message: string): void {
    this.sendJson(res, 503, { ok: false, error: 'unavailable', message })
  }

  private sendJson(res: ServerResponse, status: number, body: unknown, headOnly = false): void {
    if (res.headersSent || res.writableEnded) return
    const payload = `${JSON.stringify(body)}\n`
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(payload),
      'cache-control': 'no-store'
    })
    res.end(headOnly ? undefined : payload)
  }
}

/** 校验并规整 manifest：字段缺失或类型不对直接抛错（路由回 503）。 */
function normalizeManifest(value: unknown): FirmwareManifest {
  if (value === null || typeof value !== 'object') throw new Error('manifest 不是 JSON 对象')
  const record = value as Record<string, unknown>
  const text = (key: string): string => {
    const field = record[key]
    if (typeof field !== 'string' || field.trim() === '') throw new Error(`manifest 缺少字符串字段 ${key}`)
    return field.trim()
  }
  const size = record.size
  if (typeof size !== 'number' || !Number.isInteger(size) || size <= 0) {
    throw new Error('manifest 的 size 必须是正整数')
  }
  const offset = record.flashOffset
  if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0) {
    throw new Error('manifest 的 flashOffset 必须是非负整数')
  }
  const sha256 = text('sha256').toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error('manifest 的 sha256 必须是 64 位小写 hex')
  return {
    plugin: text('plugin'),
    chip: text('chip'),
    version: text('version'),
    commit: typeof record.commit === 'string' ? record.commit.trim() : '',
    flashOffset: offset,
    size,
    sha256,
    builtAt: text('builtAt')
  }
}

/** `If-None-Match` 命中当前 sha256（允许 `W/` 前缀与逗号列表）。 */
function matchesEtag(header: string | string[] | undefined, sha256: string): boolean {
  const raw = Array.isArray(header) ? header.join(',') : header
  if (typeof raw !== 'string' || raw.trim() === '') return false
  for (const part of raw.split(',')) {
    const token = part.trim().replace(/^W\//i, '')
    if (token === '*') return true
    if (token === `"${sha256}"` || token === sha256) return true
  }
  return false
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
