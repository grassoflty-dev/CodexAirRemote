/**
 * host 侧固件烧录：esptool-js + node-serialport，真机走 USB-Serial/JTAG（ESP32-C6）。
 *
 * 浏览器不再用 Web Serial 烧录，改由宿主进程独占串口：
 *  - 校验内置镜像：读 `firmware/codex_air_remote-merged.bin` + `manifest.json`，
 *    **host 自己算 sha256 与 manifest 比对**（前端传来的东西一律不信）。
 *  - `fileArray: [{ data, address: 0 }]`、`flashSize/flashMode/flashFreq: 'keep'`、
 *    `eraseAll: false`、`compress: true`；带 `calculateMD5Hash` 让 esptool 写完做 MD5 校验。
 *  - 烧完必须 **关串口 + EN 硬复位**，否则芯片停在 stub，板子不跑 App。
 *  - 取消（`AbortSignal`）和任何异常都走 finally：释放串口 → EN 复位，绝不留独占句柄。
 *
 * 错误码与契约一致：no-board | open-failed | timeout | rejected | busy | internal |
 * sha256-mismatch | cancelled。
 */

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { FIRMWARE_IMAGE_FILE, FIRMWARE_MANIFEST_FILE, type FirmwareManifest } from './firmware-routes.js'
import {
  findSerialPortEntry,
  loadEsptool,
  NodeSerialPortDevice,
  pulseEnReset,
  releaseSerial,
  ROM_BAUD_RATE,
  type EspLoader,
  type EspTransport,
  type SerialPortEntry
} from './serial-transport.js'

/**
 * 烧录用的名义波特率。
 *
 * USB-Serial/JTAG 上这个数字只是「名义值」：数据走 USB 全速，改不改都不影响实际吞吐。
 * 460800 的风险在于 `ESPLoader` 发现 `romBaudrate !== baudrate` 时会走 `changeBaud()`：
 * 先发 ESP_CHANGE_BAUDRATE，再让 Transport 改宿主侧波特率（我们的设备实现了
 * `setBaudRate`，所以是就地 `update()`，不重开端口），然后读寄存器确认响应；
 * 读不到就 disconnect + 按 115200 重连并重传 stub。这条回退链在真机上验证过（见交付报告）。
 */
export const FLASH_BAUD_RATE = 460800

/** 与 manifest 对不上的错误码。 */
export type FlashErrorCode =
  | 'no-board'
  | 'open-failed'
  | 'timeout'
  | 'rejected'
  | 'busy'
  | 'internal'
  | 'sha256-mismatch'
  | 'cancelled'

/** 烧录失败：`code` 直接对应契约里的错误码，`message` 是给人看的中文。 */
export class FlashError extends Error {
  readonly code: FlashErrorCode

  constructor(code: FlashErrorCode, message: string) {
    super(message)
    this.name = 'FlashError'
    this.code = code
  }
}

export interface FlashFirmwareOptions {
  /** 插件包根下的 `firmware/` 目录（绝对路径）。 */
  firmwareDir: string
  /** 目标串口，如 `COM7`。 */
  port: string
  /** esptool 原始输出逐行回调（`onLine` 里抛错不会影响烧录）。 */
  onLine?: (line: string) => void
  /** 进度 0..100（附带已写 / 总字节数，总字节数是压缩后的传输量）。 */
  onProgress?: (percent: number, written: number, total: number) => void
  /** 取消信号：在进度回调里检查，抛 `cancelled`。 */
  signal?: AbortSignal
  /** 测试 / 调参用；默认见 `FLASH_BAUD_RATE` / `ROM_BAUD_RATE`。 */
  baudRate?: number
  romBaudRate?: number
  /** 非致命告警（如 EN 复位失败）；烧录本身已经成功时不因此判失败。 */
  onWarn?: (message: string) => void
}

export interface FlashResult {
  port: string
  /** 从开始校验镜像到芯片复位完成的秒数（一位小数）。 */
  seconds: number
  /** 实际烧进 flash 的镜像 sha256（与 manifest 一致）。 */
  sha256: string
  /** 镜像字节数（未压缩）。 */
  bytes: number
}

interface LoadedImage {
  manifest: FirmwareManifest
  data: Uint8Array
}

/**
 * 读并校验内置固件。sha256 在 host 侧重算，和 manifest 不一致直接拒绝——
 * 这样镜像被截断 / 换包 / 半写入都不会烧进板子。
 */
export async function loadFirmwareImage(firmwareDir: string): Promise<LoadedImage> {
  const manifestPath = join(firmwareDir, FIRMWARE_MANIFEST_FILE)
  const imagePath = join(firmwareDir, FIRMWARE_IMAGE_FILE)

  let manifest: FirmwareManifest
  try {
    const parsed = JSON.parse(await readFile(manifestPath, 'utf8')) as unknown
    manifest = normalizeManifest(parsed)
  } catch (error) {
    throw new FlashError(
      'internal',
      `内置固件 manifest 不可用（${manifestPath}）：${describe(error)}。请先在开发机跑 scripts/bundle-firmware.mjs`
    )
  }

  let data: Buffer
  try {
    data = await readFile(imagePath)
  } catch (error) {
    throw new FlashError(
      'internal',
      `内置固件镜像不可读（${imagePath}）：${describe(error)}。请先在开发机跑 scripts/bundle-firmware.mjs`
    )
  }

  if (data.length !== manifest.size) {
    throw new FlashError(
      'sha256-mismatch',
      `内置固件大小与 manifest 不一致：${imagePath} 是 ${String(data.length)} 字节，manifest 写的是 ${String(manifest.size)} 字节`
    )
  }
  const actual = createHash('sha256').update(data).digest('hex')
  if (actual !== manifest.sha256.toLowerCase()) {
    throw new FlashError(
      'sha256-mismatch',
      `内置固件 sha256 校验失败：${imagePath} 实际 ${actual}，manifest 是 ${manifest.sha256}。请重跑 scripts/bundle-firmware.mjs`
    )
  }

  return { manifest, data: new Uint8Array(data) }
}

/**
 * 烧录内置合并镜像。
 *
 * 副作用：占用串口 → 校验镜像 → 连接芯片（必要时上传 stub）→ 写 flash → MD5 校验 →
 * 关串口 → EN 硬复位。无论成功、失败、取消，串口都会被关掉并复位芯片。
 */
export async function flashFirmware(options: FlashFirmwareOptions): Promise<FlashResult> {
  const started = Date.now()
  const port = options.port.trim()
  const baudRate = options.baudRate ?? FLASH_BAUD_RATE
  const romBaudRate = options.romBaudRate ?? ROM_BAUD_RATE

  if (port === '') throw new FlashError('no-board', '没有指定串口，找不到 ESP32-C6 开发板')
  throwIfAborted(options.signal)

  // 先把镜像校验完再碰串口：镜像不对时不动板子、不占句柄。
  const image = await loadFirmwareImage(options.firmwareDir)
  throwIfAborted(options.signal)

  let device: NodeSerialPortDevice | undefined
  let transport: EspTransport | undefined
  let loader: EspLoader | undefined
  /** 只有真的碰到了串口才需要 EN 复位；连 serialport 都没加载成功时不要空跑 Powershell。 */
  let touchedPort = false

  try {
    const esptool = await loadEsptool()
    let entry: SerialPortEntry | undefined
    try {
      entry = await findSerialPortEntry(port)
    } catch (error) {
      // serialport 原生绑定不可用：烧录没法继续，但不能说成「没插板子」。
      throw new FlashError('internal', `串口不可用（${port}）：${describe(error)}`)
    }
    if (entry === undefined) {
      throw new FlashError('no-board', `未找到串口 ${port}（ESP32-C6 没插好，或 USB 驱动还没就绪）`)
    }
    device = new NodeSerialPortDevice(
      port,
      entry.vendorId !== undefined ? Number.parseInt(entry.vendorId, 16) : undefined,
      entry.productId !== undefined ? Number.parseInt(entry.productId, 16) : undefined
    )
    touchedPort = true

    const terminal = {
      clean: () => undefined,
      write: (data: string) => emitLines(options.onLine, data),
      writeLine: (data: string) => emitLines(options.onLine, data)
    }
    transport = new esptool.Transport(device)
    loader = new esptool.ESPLoader({ transport, baudrate: baudRate, romBaudrate: romBaudRate, terminal })

    // main()：连接 → 识别芯片 → 上传 stub →（必要时换波特率）→ 读 flash id
    await loader.main()
    throwIfAborted(options.signal)

    await loader.writeFlash({
      fileArray: [{ data: image.data, address: 0 }],
      flashSize: 'keep',
      flashMode: 'keep',
      flashFreq: 'keep',
      eraseAll: false,
      compress: true,
      // 打开后 esptool 写完会回读 flash 的 MD5 并比对（"Hash of data verified."）
      calculateMD5Hash: (bytes) => createHash('md5').update(bytes).digest('hex'),
      reportProgress: (_fileIndex, written, total) => {
        // 取消只能在这里打断：每个 16 KB 块之间检查一次，响应时间 ~几十毫秒。
        throwIfAborted(options.signal)
        if (total > 0) options.onProgress?.(Math.min(100, Math.round((written / total) * 100)), written, total)
      }
    })

    options.onProgress?.(100, image.data.length, image.data.length)
    return { port, seconds: secondsSince(started), sha256: image.manifest.sha256, bytes: image.data.length }
  } catch (error) {
    throw mapFlashError(error, port)
  } finally {
    // 顺序不能变：先放传输层 / 关串口，再 EN 复位（PowerShell 需要独占句柄）。
    await releaseSerial(device, transport)
    if (touchedPort) {
      try {
        await pulseEnReset(port)
      } catch (error) {
        // 复位失败不改变烧录结果，但要留痕：板子可能还停在 stub。
        options.onWarn?.(`airremote: ${port} EN 复位失败：${describe(error)}`)
      }
    }
  }
}

/** 把任意异常映射成契约错误码。 */
function mapFlashError(error: unknown, port: string): FlashError {
  if (error instanceof FlashError) return error
  if (isAbortError(error)) return new FlashError('cancelled', '烧录已取消')

  const message = describe(error)
  const name = error instanceof Error ? error.name : ''

  if (/access is denied|access denied|拒绝访问|being used by another process|EBUSY|EACCES|resource busy/i.test(message)) {
    return new FlashError('busy', `串口 ${port} 被其它程序占用，请关闭串口监视器 / 烧录工具后重试（${message}）`)
  }
  if (name === 'TimeoutError' || /timed out|timeout|超时/i.test(message)) {
    return new FlashError('timeout', `与 ${port} 通信超时：${message}`)
  }
  if (/Failed to connect with the device|Failed to connect|no serial data received|could not open port/i.test(message)) {
    return new FlashError('timeout', `连接 ${port} 上的 ESP32-C6 超时：${message}`)
  }
  if (/Opening COM|Cannot open|Failed to open|打开 .* 超时/i.test(message)) {
    return new FlashError('open-failed', `打开串口 ${port} 失败：${message}`)
  }
  if (name === 'ESPError' || /^Invalid (head of packet|response)|Unexpected response|Wrong argument|Command not found/i.test(message)) {
    return new FlashError('rejected', `开发板拒绝了烧录命令：${message}`)
  }
  if (/没有导出|Cannot find (module|package)|ERR_MODULE_NOT_FOUND/i.test(message)) {
    return new FlashError('internal', `烧录依赖不可用：${message}`)
  }
  return new FlashError('internal', `烧录失败：${message}`)
}

/** 已经取消就立刻抛 `cancelled`（取消后不再碰串口）。 */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new FlashError('cancelled', '烧录已取消')
}

function isAbortError(error: unknown): boolean {
  return error instanceof FlashError && error.code === 'cancelled'
}

/** esptool 的 terminal 输出是任意分片，按行拆开再回调。 */
function emitLines(onLine: ((line: string) => void) | undefined, data: string): void {
  if (onLine === undefined || data === '') return
  for (const line of data.split(/\r?\n/)) {
    if (line !== '') {
      try {
        onLine(line)
      } catch {
        /* 回调（WS 已断）出错不能影响烧录收尾 */
      }
    }
  }
}

function secondsSince(startedAt: number): number {
  return Math.round((Date.now() - startedAt) / 100) / 10
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 校验并规整 manifest：字段缺失或类型不对直接抛错（上层映射成 internal）。 */
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
