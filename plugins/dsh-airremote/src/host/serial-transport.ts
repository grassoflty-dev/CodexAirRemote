/**
 * node-serialport → esptool-js Transport 适配层（已在真机 ESP32-C6 / COM7 上跑通）。
 *
 * 用法：
 *   const info = await readChipInfo('COM7')
 *   // 烧录见 `flash-service.ts`
 *
 * 设计要点（踩过的坑都写在这里，改之前先读完）：
 *  - 只实现 esptool-js `Transport` 真正会调到的 WebSerial 子集：
 *    open / close / readable / writable / setSignals / getInfo / getVid / getPid（+ 可选 setBaudRate）。
 *  - 读写缓冲自己做（不用 ReadableStream），这样 cancel() 能立刻唤醒挂起的 read()，
 *    `waitForUnlock` 不会死循环。
 *  - 收尾必须 `transport.disconnect()` → `device.forceUnlock()` → `device.close()`，
 *    关不掉时 destroy() 兜底——和 `serial-port.ts` 的 close 模式一致。
 *    **任何异常路径都必须走 `releaseSerial()`**，否则 Windows 的独占句柄会一直挂着，
 *    之后所有 open 都是 Access denied，只能拔插 USB 或杀宿主进程。
 *  - 芯片从 stub / 下载模式回到 App **必须**用 EN 脉冲（RTS 拉高 200ms 再拉低）。
 *    `loader.after('hard_reset')` 无效（它走 RTS，而 node-serialport 推不动 RTS：
 *    `@serialport/bindings-cpp` 打开端口时写死 `RTS_CONTROL_DISABLE`）；
 *    `UsbJtagSerialReset` 会**进**下载模式。唯一可行的是关串口后用一次性 PowerShell
 *    设 `RtsEnable`。所以 `pulseEnReset()` 必须在本文件里、串口关闭之后调用。
 *  - esptool-js 用**变量**形式的动态 import 加载：它自带的 d.ts `/// <reference
 *    types="w3c-web-serial" />` 在本仓库没装（也不需要），字面量 import 会让 tsc
 *    去找这个类型包；变量形式既绕过类型解析，也绕过打包器的静态收集。
 */

import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

const OPEN_TIMEOUT_MS = 5000
const CLOSE_TIMEOUT_MS = 1000
const SIGNAL_TIMEOUT_MS = 2000

/** esptool-js 的 ROM 波特率：USB-Serial/JTAG 下 baud 只是名义值，实际走 USB 全速。 */
export const ROM_BAUD_RATE = 115200

type SerialPortLike = {
  isOpen: boolean
  open(callback: (error?: Error | null) => void): void
  close(callback?: (error?: Error | null) => void): void
  destroy(): void
  on(event: string, listener: (...args: never[]) => void): unknown
  off(event: string, listener: (...args: never[]) => void): unknown
  write(data: Uint8Array, callback: (error?: Error | null) => void): unknown
  drain(callback: (error?: Error | null) => void): unknown
  set(options: { dtr?: boolean; rts?: boolean; brk?: boolean }, callback: (error?: Error | null) => void): void
  update(options: { baudRate: number }, callback: (error?: Error | null) => void): void
}

/** `SerialPort.list()` 的一条记录（只留这里用得到的字段）。 */
export interface SerialPortEntry {
  path?: string
  vendorId?: string
  productId?: string
}

type SerialPortConstructor = new (options: Record<string, unknown>) => SerialPortLike

type SerialPortModule = {
  SerialPort: SerialPortConstructor & { list(): Promise<SerialPortEntry[]> }
}

let serialportModule: SerialPortModule | undefined

/**
 * 加载 `serialport`（原生绑定）。宿主是 ESM bundle，用 `createRequire(import.meta.url)`
 * 从插件包自己的 node_modules 解析——`serial-port.ts` 也是同一套办法。
 */
export function loadSerialport(): SerialPortModule {
  if (serialportModule !== undefined) return serialportModule
  const loaded = require('serialport') as {
    SerialPort?: SerialPortConstructor & { list(): Promise<SerialPortEntry[]> }
    default?: { SerialPort?: SerialPortConstructor & { list(): Promise<SerialPortEntry[]> } }
  }
  const SerialPort = loaded.SerialPort ?? loaded.default?.SerialPort
  if (typeof SerialPort !== 'function') throw new Error('serialport 里没有导出 SerialPort')
  serialportModule = { SerialPort }
  return serialportModule
}

/** 列出串口；`serialport` 不可用时抛错（烧录本来就依赖它，不能静默降级）。 */
export async function listSerialPorts(): Promise<SerialPortEntry[]> {
  return loadSerialport().SerialPort.list()
}

/** 按名字（大小写不敏感）找一条端口记录；找不到返回 undefined。 */
export async function findSerialPortEntry(port: string): Promise<SerialPortEntry | undefined> {
  const target = port.trim().toUpperCase()
  const entries = await listSerialPorts()
  return entries.find((entry) => (entry.path ?? '').toUpperCase() === target)
}

/**
 * WebSerial `SerialPort` 的 Node 等价物：只覆盖 esptool-js 用到的部分。
 * 结构化类型，运行时被 `Transport` 直接使用（`ESPLoader` 只鸭子类型调用，不检查原型）。
 */
export class NodeSerialPortDevice {
  readonly readable = {
    locked: false,
    getReader: (): {
      read(): Promise<{ value?: Uint8Array; done: boolean }>
      cancel(): Promise<void>
      releaseLock(): void
    } => {
      this.readable.locked = true
      return {
        read: () => this.read(),
        cancel: async () => this.end(),
        releaseLock: () => {
          this.readable.locked = false
        }
      }
    },
    cancel: async (): Promise<void> => this.end()
  }

  readonly writable = {
    locked: false,
    getWriter: (): { write(chunk: Uint8Array): Promise<void>; close(): Promise<void>; releaseLock(): void } => {
      this.writable.locked = true
      return {
        write: async (chunk: Uint8Array) => {
          try {
            await this.writeChunk(chunk)
          } finally {
            this.writable.locked = false
          }
        },
        // Transport.flushOutput() 会调它；不真的关端口，关端口是 disconnect() 的事
        close: async () => {
          this.writable.locked = false
        },
        releaseLock: () => {
          this.writable.locked = false
        }
      }
    }
  }

  private port: SerialPortLike | undefined
  private chunks: Uint8Array[] = []
  private waiters: Array<(result: { value?: Uint8Array; done: boolean }) => void> = []
  private ended = true
  private listeners: Array<[string, (...args: never[]) => void]> = []

  constructor(
    private readonly path: string,
    private readonly vendorId: number | undefined,
    private readonly productId: number | undefined,
    private readonly module: SerialPortModule = loadSerialport()
  ) {}

  getInfo(): { usbVendorId: number | undefined; usbProductId: number | undefined } {
    return { usbVendorId: this.vendorId, usbProductId: this.productId }
  }

  getVid(): number | undefined {
    return this.vendorId
  }

  getPid(): number | undefined {
    return this.productId
  }

  async open(options: { baudRate?: number; dataBits?: number; stopBits?: number; parity?: string } = {}): Promise<void> {
    if (this.port?.isOpen === true) return
    this.end()
    this.ended = false
    this.chunks = []
    this.waiters = []

    const port = new this.module.SerialPort({
      path: this.path,
      baudRate: options.baudRate ?? ROM_BAUD_RATE,
      dataBits: options.dataBits ?? 8,
      stopBits: options.stopBits ?? 1,
      parity: options.parity ?? 'none',
      rtscts: false,
      xon: false,
      xoff: false,
      autoOpen: false
    })
    this.port = port

    const onData = (chunk: Uint8Array): void => this.push(Uint8Array.from(chunk))
    const onClose = (): void => this.end()
    const onError = (): void => undefined
    port.on('data', onData)
    port.on('close', onClose)
    port.on('error', onError)
    this.listeners = [
      ['data', onData],
      ['close', onClose],
      ['error', onError]
    ]

    await withTimeout(
      new Promise<void>((resolve, reject) => port.open((error) => (error ? reject(error) : resolve()))),
      OPEN_TIMEOUT_MS,
      `打开 ${this.path} 超时`
    )
  }

  async close(): Promise<void> {
    this.end()
    const port = this.port
    this.port = undefined
    if (port === undefined) return
    for (const [event, handler] of this.listeners) {
      try {
        port.off(event, handler)
      } catch {
        /* ignore */
      }
    }
    this.listeners = []
    await new Promise<void>((resolve) => {
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve()
      }
      const destroy = (): void => {
        try {
          port.destroy()
        } catch {
          /* ignore */
        }
      }
      const timer = setTimeout(() => {
        destroy()
        finish()
      }, CLOSE_TIMEOUT_MS)
      timer.unref?.()
      try {
        port.close(() => {
          if (port.isOpen === true) destroy()
          finish()
        })
      } catch {
        destroy()
        finish()
      }
    })
  }

  async setSignals(signals: { dataTerminalReady?: boolean; requestToSend?: boolean; break?: boolean } = {}): Promise<void> {
    const port = this.port
    if (port === undefined || !port.isOpen) return
    const payload: { dtr?: boolean; rts?: boolean; brk?: boolean } = {}
    if (typeof signals.dataTerminalReady === 'boolean') payload.dtr = signals.dataTerminalReady
    if (typeof signals.requestToSend === 'boolean') payload.rts = signals.requestToSend
    if (typeof signals.break === 'boolean') payload.brk = signals.break
    if (Object.keys(payload).length === 0) return
    await withTimeout(
      new Promise<void>((resolve, reject) => port.set(payload, (error) => (error ? reject(error) : resolve()))),
      SIGNAL_TIMEOUT_MS,
      'setSignals 超时'
    )
  }

  /**
   * 就地改波特率（不重开端口）；`Transport.changeBaudrate()` 优先调它。
   * USB-Serial/JTAG 上 baud 只是名义值，改不改都不影响实际吞吐。
   */
  async setBaudRate(baudRate: number): Promise<void> {
    const port = this.port
    if (port === undefined || !port.isOpen) return
    await withTimeout(
      new Promise<void>((resolve, reject) => port.update({ baudRate }, (error) => (error ? reject(error) : resolve()))),
      SIGNAL_TIMEOUT_MS,
      'setBaudRate 超时'
    )
  }

  /** 写原始字节（不经 SLIP）：读普通控制台文本时用。 */
  async writeRaw(bytes: Uint8Array): Promise<void> {
    await this.writeChunk(bytes)
  }

  /** 兜底：解除可能被遗弃的锁，避免 Transport.waitForUnlock 死循环。 */
  forceUnlock(): void {
    this.readable.locked = false
    this.writable.locked = false
  }

  private read(): Promise<{ value?: Uint8Array; done: boolean }> {
    if (this.chunks.length > 0) return Promise.resolve({ value: this.chunks.shift(), done: false })
    if (this.ended) return Promise.resolve({ done: true })
    return new Promise((resolve) => {
      this.waiters.push(resolve)
    })
  }

  private push(chunk: Uint8Array): void {
    if (this.ended || chunk.length === 0) return
    const waiter = this.waiters.shift()
    if (waiter !== undefined) waiter({ value: chunk, done: false })
    else this.chunks.push(chunk)
  }

  private end(): void {
    if (this.ended && this.waiters.length === 0) return
    this.ended = true
    const waiters = this.waiters
    this.waiters = []
    for (const waiter of waiters) waiter({ done: true })
  }

  private writeChunk(chunk: Uint8Array): Promise<void> {
    const port = this.port
    if (port === undefined || !port.isOpen) return Promise.reject(new Error('串口未打开'))
    return new Promise<void>((resolve, reject) => {
      port.write(chunk, (error) => {
        if (error) {
          reject(error)
          return
        }
        port.drain(() => resolve())
      })
    })
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    timer.unref?.()
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    )
  })
}

/* ------------------------------------------------------------------ *
 * esptool-js（变量形式的动态 import，见文件头注释）
 * ------------------------------------------------------------------ */

/** esptool-js 终端回调：`ESPLoader` 的所有输出都从这里走，直接转成 WS 的 log 行。 */
export interface EsptoolTerminal {
  clean?: () => void
  write?: (data: string) => void
  writeLine?: (data: string) => void
}

export interface EspFlashOptions {
  fileArray: { data: Uint8Array; address: number }[]
  flashSize: string
  flashMode: string
  flashFreq: string
  eraseAll: boolean
  compress: boolean
  calculateMD5Hash?: (image: Uint8Array) => string
  reportProgress?: (fileIndex: number, written: number, total: number) => void
}

export interface EspChip {
  CHIP_NAME: string
  getChipRevision?(loader: unknown): Promise<number>
  getChipFeatures?(loader: unknown): Promise<string[]>
  getCrystalFreq?(loader: unknown): Promise<number>
  readMac?(loader: unknown): Promise<string>
}

/** `ESPLoader` 的结构化视图：只声明本插件真正用到的成员。 */
export interface EspLoader {
  chip: EspChip
  main(mode?: string): Promise<string>
  readFlashId(): Promise<number>
  writeFlash(options: EspFlashOptions): Promise<void>
  after(mode?: string): Promise<void>
}

export interface EspTransport {
  tracing: boolean
  device: unknown
  disconnect(): Promise<void>
}

export interface EsptoolModule {
  ESPLoader: new (options: Record<string, unknown>) => EspLoader
  Transport: new (device: unknown, tracing?: boolean, enableSlipReader?: boolean) => EspTransport
}

/** 加载 esptool-js。失败说明依赖没装好——烧录没法继续，让调用方映射成 `internal`。 */
export async function loadEsptool(): Promise<EsptoolModule> {
  const specifier = 'esptool-js'
  const loaded = (await import(/* @vite-ignore */ specifier)) as unknown as Partial<EsptoolModule>
  if (typeof loaded.ESPLoader !== 'function' || typeof loaded.Transport !== 'function') {
    throw new Error('esptool-js 里没有导出 ESPLoader / Transport')
  }
  return { ESPLoader: loaded.ESPLoader, Transport: loaded.Transport }
}

/** 打开端口用的设备对象：VID/PID 从 `SerialPort.list()` 里取（取不到就留空）。 */
export async function createSerialDevice(port: string): Promise<NodeSerialPortDevice> {
  const entry = await findSerialPortEntry(port)
  const vendorId = entry?.vendorId !== undefined ? Number.parseInt(entry.vendorId, 16) : undefined
  const productId = entry?.productId !== undefined ? Number.parseInt(entry.productId, 16) : undefined
  return new NodeSerialPortDevice(port, vendorId, productId)
}

/* ------------------------------------------------------------------ *
 * 收尾：任何异常路径都必须走到这里
 * ------------------------------------------------------------------ */

/**
 * 释放串口：`transport.disconnect()` → `forceUnlock()` → `device.close()`。
 * 每一步都吞异常：收尾阶段抛错没有意义，但**必须全部执行**，漏一步就是句柄泄漏。
 */
export async function releaseSerial(device: NodeSerialPortDevice | undefined, transport: EspTransport | undefined): Promise<void> {
  try {
    await transport?.disconnect()
  } catch {
    /* 已经断了就算了 */
  }
  try {
    device?.forceUnlock()
  } catch {
    /* ignore */
  }
  try {
    await device?.close()
  } catch {
    /* ignore */
  }
}

/* ------------------------------------------------------------------ *
 * EN 硬复位：node-serialport 推不动 RTS，只能走 one-shot PowerShell
 * ------------------------------------------------------------------ */

const POWERSHELL_EN_PULSE = String.raw`
$ErrorActionPreference = 'Stop'
$sp = New-Object System.IO.Ports.SerialPort
$sp.PortName = $env:AR_PORT
$sp.BaudRate = [int]$env:AR_BAUD
$sp.DataBits = 8
$sp.Parity = [System.IO.Ports.Parity]::None
$sp.StopBits = [System.IO.Ports.StopBits]::One
$sp.Handshake = [System.IO.Ports.Handshake]::None
$sp.ReadTimeout = 200
try {
  $sp.Open()
  $sp.RtsEnable = $true
  Start-Sleep -Milliseconds 200
  $sp.RtsEnable = $false
  Write-Output 'PULSE_OK'
} finally {
  if ($sp.IsOpen) { $sp.Close() }
}
exit 0
`

/**
 * 把芯片从 stub / 下载模式带回固件：RTS(EN) 拉高 200ms 再拉低。
 *
 * **调用前必须已经把串口关掉**（Windows 独占句柄，PowerShell 抢不到会报 Access denied）。
 * PowerShell 是 `powershell.exe`（Windows 一定存在；pwsh 不一定），参数走环境变量。
 */
export function pulseEnReset(port: string, baudRate = ROM_BAUD_RATE): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', POWERSHELL_EN_PULSE],
      {
        timeout: 10000,
        windowsHide: true,
        env: { ...process.env, AR_PORT: port, AR_BAUD: String(baudRate) }
      },
      (error, stdout) => {
        if (error !== null || !String(stdout).includes('PULSE_OK')) {
          reject(new Error(`EN 复位失败：${error?.message ?? String(stdout)}`))
          return
        }
        resolve()
      }
    )
  })
}

/* ------------------------------------------------------------------ *
 * 一次性读芯片信息
 * ------------------------------------------------------------------ */

export interface BoardChipInfo {
  chipDescription: string
  chipName: string
  revision?: number
  features?: string[]
  crystalMHz?: number
  mac?: string
  flashId?: string
  /** 芯片连接时被 esptool-js 打印的原始行，便于排查。 */
  lines: string[]
}

/**
 * 连上板子读芯片信息（只读：不上 flash、不擦除）。
 * 结束时一定：关串口 → EN 硬复位（把芯片从 stub 带回 App）。
 * 用于自检 / 测试；烧录走 `flash-service.ts`。
 */
export async function readChipInfo(port: string, onLine?: (line: string) => void): Promise<BoardChipInfo> {
  const device = await createSerialDevice(port)
  const { ESPLoader, Transport } = await loadEsptool()

  const lines: string[] = []
  const terminal = {
    clean: () => {
      lines.length = 0
    },
    write: (data: string) => {
      for (const line of data.split(/\r?\n/)) {
        if (line !== '') {
          lines.push(line)
          onLine?.(line)
        }
      }
    },
    writeLine: (data: string) => {
      lines.push(data)
      onLine?.(data)
    }
  }

  const transport = new Transport(device)
  const loader = new ESPLoader({
    transport,
    baudrate: ROM_BAUD_RATE,
    romBaudrate: ROM_BAUD_RATE,
    terminal
  })

  try {
    const chipDescription = await loader.main()
    const info: BoardChipInfo = {
      chipDescription,
      chipName: loader.chip.CHIP_NAME,
      lines
    }
    info.revision = await loader.chip.getChipRevision?.(loader)
    info.features = await loader.chip.getChipFeatures?.(loader)
    info.crystalMHz = await loader.chip.getCrystalFreq?.(loader)
    info.mac = await loader.chip.readMac?.(loader)
    info.flashId = `0x${(await loader.readFlashId()).toString(16)}`
    return info
  } finally {
    await releaseSerial(device, transport)
    // 端口关掉之后再做 EN 复位：把芯片带回固件，控制台恢复可用
    await pulseEnReset(port).catch(() => undefined)
  }
}
