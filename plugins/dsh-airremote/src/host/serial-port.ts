/**
 * 串口：识别 ESP32-C6 开发板（USB VID 0x303A）并把时间 / 时区写进去。
 *
 * 两条通道：
 *  - `serialport` npm 包可用时走它（首选）；
 *  - 否则用一次性的 PowerShell 进程（`[System.IO.Ports.SerialPort]`），
 *    一个脚本完成打开 / 写 / 读到匹配 / 关闭，用独特分隔符回传结果。
 *
 * 只做一次性动作：不轮询、不监听插拔、不留后台定时器。
 */

import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { StringDecoder } from 'node:string_decoder'

const require = createRequire(import.meta.url)

/** Espressif 的 USB VID。固件用 USB-Serial/JTAG，端口一定挂在它下面。 */
export const ESPRESSIF_VENDOR_ID = '303A'

/** 与 `voice.c` 的串口命令一致：115200 8N1，无流控。 */
export const BOARD_BAUD_RATE = 115200

/** 单条命令等回包的上限。 */
const COMMAND_TIMEOUT_MS = 3000
/** 一次同步（AR1T + AR1Z）的总时长上限。 */
const SYNC_TIMEOUT_MS = 10000
/** PowerShell 进程本身的超时（含进程启动开销）。 */
const POWERSHELL_TIMEOUT_MS = 15000

export type BoardSyncErrorCode = 'open-failed' | 'timeout' | 'rejected' | 'internal'

/** 同步失败：`code` 直接对应契约里的错误码。 */
export class BoardSyncError extends Error {
  readonly code: BoardSyncErrorCode
  /** 已经收到 / 发出的原始行，便于界面上排查。 */
  readonly lines: string[]

  constructor(code: BoardSyncErrorCode, message: string, lines: string[] = []) {
    super(message)
    this.name = 'BoardSyncError'
    this.code = code
    this.lines = lines
  }
}

export interface BoardSyncResult {
  /** 发出去的命令行。 */
  sent: string[]
  /** 从板子读到的行（含开机日志）。 */
  lines: string[]
}

interface PortInfo {
  path?: string
  vendorId?: string
}

interface SerialPortInstance {
  isOpen?: boolean
  open(callback: (error: Error | null) => void): void
  close(callback?: (error?: Error | null) => void): void
  destroy?(error?: Error | null): void
  write(data: string, callback?: (error?: Error | null) => void): unknown
  on(event: string, listener: (...args: never[]) => void): unknown
  off?(event: string, listener: (...args: never[]) => void): unknown
  removeListener?(event: string, listener: (...args: never[]) => void): unknown
}

interface SerialPortConstructor {
  new (options: Record<string, unknown>): SerialPortInstance
  list(): Promise<PortInfo[]>
}

interface SerialportModule {
  SerialPort: SerialPortConstructor
}

let serialportProbe: Promise<SerialportModule | undefined> | undefined
let serialportFailure = ''

/** 排障开关：`AIRREMOTE_SERIAL_FORCE_PS=1` 时绕开 serialport，强制走 PowerShell 通道。 */
function serialportDisabled(): boolean {
  return (process.env.AIRREMOTE_SERIAL_FORCE_PS ?? '').trim() === '1'
}

/**
 * 尝试加载 `serialport`，并用一次 `SerialPort.list()` 证明原生绑定真的可用
 * （Node 大版本升级后 prebuild ABI 可能对不上，模块能 require 但一用就炸）。
 * 失败时记住原文并永久回落到 PowerShell，免得每次同步都等一次失败。
 */
async function loadSerialport(): Promise<SerialportModule | undefined> {
  serialportProbe ??= (async (): Promise<SerialportModule | undefined> => {
    if (serialportDisabled()) {
      serialportFailure = 'AIRREMOTE_SERIAL_FORCE_PS=1'
      return undefined
    }
    try {
      const loaded = require('serialport') as {
        SerialPort?: SerialPortConstructor
        default?: { SerialPort?: SerialPortConstructor }
      }
      const SerialPort = loaded.SerialPort ?? loaded.default?.SerialPort
      if (typeof SerialPort !== 'function') throw new Error('serialport 里没有导出 SerialPort')
      await SerialPort.list()
      return { SerialPort }
    } catch (error) {
      serialportFailure = error instanceof Error ? error.message : String(error)
      return undefined
    }
  })()
  return serialportProbe
}

/** `serialport` 不可用时的原因（空串表示可用或还没探测过），用于日志与排查。 */
export function serialportFailureReason(): string {
  return serialportFailure
}

/* ------------------------------------------------------------------ *
 * 端口发现
 * ------------------------------------------------------------------ */

/**
 * 找一个 ESP32-C6 的串口。
 *
 * `preferred` 非空时直接用它（配置 / 环境变量里的显式指定）；
 * 否则先问 `serialport`，再兜底查注册表，最后退到 CIM 的 PnP 设备。
 * 全部失败返回 null——**不**把「只有一个串口」当作识别成功。
 */
export async function findBoardPort(preferred = ''): Promise<string | null> {
  const explicit = preferred.trim() !== '' ? preferred.trim() : (process.env.AIRREMOTE_SERIAL_PORT ?? '').trim()
  if (explicit !== '') return explicit

  const module = await loadSerialport()
  if (module !== undefined) {
    try {
      const ports = await module.SerialPort.list()
      const board = ports.find((port) => (port.vendorId ?? '').toLowerCase() === ESPRESSIF_VENDOR_ID)
      if (board?.path !== undefined && board.path !== '') return board.path
    } catch {
      /* 枚举失败就当没找到，继续走注册表兜底 */
    }
  }

  const fromRegistry = await comPortsFrom(POWERSHELL_REGISTRY_SCRIPT)
  if (fromRegistry.length > 0) return fromRegistry[0]
  const fromDevices = await comPortsFrom(POWERSHELL_PNP_SCRIPT)
  return fromDevices.length > 0 ? fromDevices[0] : null
}

/** 一个可用于「扫描设备」的串口候选。 */
export interface BoardPortInfo {
  path: string
  vendorId?: string
  productId?: string
}

/** `GET /airremote/ports` 的结果；`ok:false` 表示枚举本身失败（不是没插板）。 */
export interface BoardPortScan {
  ok: boolean
  ports: BoardPortInfo[]
  board: string | null
  code?: string
  message?: string
}

/**
 * 枚举串口并找出 ESP32-C6（VID 303A）——**只 list，不打开端口**，不占串口锁。
 * `list`/`fallback` 仅用于测试注入；生产走 `SerialPort.list()` + 注册表/PnP 兜底。
 */
export async function listBoardPorts(options: {
  list?: () => Promise<PortInfo[]>
  fallback?: () => Promise<string[]>
} = {}): Promise<BoardPortScan> {
  const ports: BoardPortInfo[] = []
  const push = (path: string | undefined, vendorId?: string, productId?: string): void => {
    const value = (path ?? '').trim()
    if (value === '') return
    if (ports.some((port) => port.path.toUpperCase() === value.toUpperCase())) return
    ports.push({
      path: value,
      ...(vendorId === undefined || vendorId === '' ? {} : { vendorId: vendorId.toUpperCase() }),
      ...(productId === undefined || productId === '' ? {} : { productId: productId.toUpperCase() })
    })
  }

  try {
    if (options.list !== undefined) {
      for (const port of await options.list()) push(port.path, port.vendorId, (port as { productId?: string }).productId)
    } else {
      const module = await loadSerialport()
      if (module !== undefined) {
        for (const port of await module.SerialPort.list()) {
          push(port.path, port.vendorId, (port as { productId?: string }).productId)
        }
      }
    }
  } catch (error) {
    if (options.list !== undefined) {
      return { ok: false, code: 'serial-error', message: toString(error), ports, board: null }
    }
    /* 真实 serialport 枚举失败：继续走注册表兜底，不让一次失败变成「没有串口」。 */
  }

  if (ports.length === 0) {
    const fallback = options.fallback ?? (async (): Promise<string[]> => {
      const fromRegistry = await comPortsFrom(POWERSHELL_REGISTRY_SCRIPT)
      if (fromRegistry.length > 0) return fromRegistry
      return comPortsFrom(POWERSHELL_PNP_SCRIPT)
    })
    // 两条兜底脚本都只查 VID_303A，所以这些端口就是开发板候选。
    for (const path of await fallback()) push(path, ESPRESSIF_VENDOR_ID)
  }

  const board = ports.find((port) => (port.vendorId ?? '').toUpperCase() === ESPRESSIF_VENDOR_ID)?.path ?? null
  return { ok: true, ports, board }
}

function toString(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 读 `HKLM\SYSTEM\CurrentControlSet\Enum\USB` 下 `VID_303A*` 设备的 `Device Parameters\PortName`。 */
const POWERSHELL_REGISTRY_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Get-ChildItem 'HKLM:\SYSTEM\CurrentControlSet\Enum\USB' |
  Where-Object { $_.PSChildName -like 'VID_303A*' } |
  ForEach-Object {
    Get-ChildItem $_.PSPath | ForEach-Object {
      $name = (Get-ItemProperty -Path (Join-Path $_.PSPath 'Device Parameters') -Name PortName).PortName
      if ($name) { Write-Output $name }
    }
  }
exit 0
`

/** 退一步：从 PnP 设备的 DeviceID 里匹配 `VID_303A`，再从名字里抠 COM 号。 */
const POWERSHELL_PNP_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Get-CimInstance Win32_PnPEntity |
  Where-Object { $_.DeviceID -like '*VID_303A*' -or $_.HardwareID -like '*VID_303A*' } |
  ForEach-Object { if ($_.Name -match '(COM\d+)') { Write-Output $Matches[1] } }
exit 0
`

async function comPortsFrom(script: string): Promise<string[]> {
  try {
    const result = await runPowerShell(script, {}, POWERSHELL_TIMEOUT_MS)
    const ports: string[] = []
    for (const line of result.stdout.split(/\r?\n/)) {
      const match = /^\s*(COM\d+)\s*$/i.exec(line)
      if (match !== null && !ports.includes(match[1].toUpperCase())) ports.push(match[1].toUpperCase())
    }
    return ports
  } catch {
    return []
  }
}

/* ------------------------------------------------------------------ *
 * 时间同步
 * ------------------------------------------------------------------ */

/**
 * 通过串口把 UTC 秒和显示时区写给板子：`AR1T <unix>` → `AR1Z <minutes>`。
 * 每条命令都要读到 OK；板子回 ERR 抛 `rejected`，等不到抛 `timeout`。
 * 端口在 finally 里关闭，不留在后台。
 */
export async function syncBoardTime(port: string, unixSeconds: number, minutes: number): Promise<BoardSyncResult> {
  const target = port.trim()
  if (target === '') throw new BoardSyncError('open-failed', '没有可用的串口')
  const module = await loadSerialport()
  if (module !== undefined) return syncWithSerialport(module, target, unixSeconds, minutes)
  return syncWithPowerShell(target, unixSeconds, minutes)
}

interface PendingLine {
  ok: RegExp
  fail: RegExp
  resolve(line: string): void
  reject(error: Error): void
}

async function syncWithSerialport(
  module: SerialportModule,
  path: string,
  unixSeconds: number,
  minutes: number
): Promise<BoardSyncResult> {
  const deadline = Date.now() + SYNC_TIMEOUT_MS
  const sent: string[] = []
  const lines: string[] = []
  const decoder = new StringDecoder('utf8')
  let buffer = ''
  let pending: PendingLine | undefined
  /** 只有真正 new 出来的端口才需要关；构造就抛错时保持 undefined。 */
  let port: SerialPortInstance | undefined

  const take = (line: string): void => {
    lines.push(line)
    const waiter = pending
    if (waiter === undefined) return
    if (waiter.ok.test(line)) {
      pending = undefined
      waiter.resolve(line)
    } else if (waiter.fail.test(line)) {
      pending = undefined
      waiter.reject(new BoardSyncError('rejected', '开发板拒绝了时间命令（AR1T ERR / AR1Z ERR）', lines.slice()))
    }
  }

  const onData = (chunk: Buffer): void => {
    buffer += decoder.write(chunk)
    let index = buffer.search(/[\r\n]/)
    while (index !== -1) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (line !== '') take(line)
      index = buffer.search(/[\r\n]/)
    }
  }

  const onError = (error: Error): void => {
    const waiter = pending
    pending = undefined
    waiter?.reject(new BoardSyncError('internal', `串口出错：${error.message}`, lines.slice()))
  }

  /** 挂一个等待器：先把坑占好再写，避免漏掉立刻回的行。超时时间受整体预算约束。 */
  const expect = (ok: RegExp, fail: RegExp, message: string): Promise<string> =>
    new Promise<string>((resolve, reject) => {
      const budget = Math.max(1, Math.min(COMMAND_TIMEOUT_MS, deadline - Date.now()))
      const timer = setTimeout(() => {
        pending = undefined
        reject(new BoardSyncError('timeout', message, lines.slice()))
      }, budget)
      timer.unref?.()
      pending = {
        ok,
        fail,
        resolve: (line) => {
          clearTimeout(timer)
          resolve(line)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        }
      }
    })

  // 整个生命周期（构造 → 打开 → 挂监听 → 收发 → 关闭）都在 try/finally 里：
  // 任何一步抛异常（包括 `port.on('data')` 这类流内部错误）都必须把端口关掉，
  // 否则 Windows 的串口会被这个进程一直占着，之后所有 open 都是 Access denied。
  try {
    port = new module.SerialPort({
      path,
      baudRate: BOARD_BAUD_RATE,
      dataBits: 8,
      stopBits: 1,
      parity: 'none',
      rtscts: false,
      xon: false,
      xoff: false,
      autoOpen: false
    })

    await new Promise<void>((resolve, reject) => {
      port!.open((error) => {
        if (error === null || error === undefined) resolve()
        else reject(new BoardSyncError('open-failed', openFailureMessage(path, error), lines.slice()))
      })
    })

    port.on('data', onData)
    port.on('error', onError)

    const writeLine = (command: string): Promise<void> =>
      new Promise<void>((resolve, reject) => {
        port!.write(`${command}\n`, (error?: Error | null) => {
          if (error === null || error === undefined) {
            sent.push(command)
            resolve()
          } else {
            reject(new BoardSyncError('internal', `写串口失败：${error.message}`, lines.slice()))
          }
        })
      })

    const timeCommand = `AR1T ${String(unixSeconds)}`
    const timeReply = expect(/^AR1T OK\b/i, /^AR1T ERR\b/i, `等待 ${timeCommand} 的回包超时`)
    void timeReply.catch(() => undefined)
    await writeLine(timeCommand)
    await timeReply

    const zoneCommand = `AR1Z ${String(minutes)}`
    const zoneReply = expect(/^AR1Z OK\b/i, /^AR1Z ERR\b/i, `等待 ${zoneCommand} 的回包超时`)
    void zoneReply.catch(() => undefined)
    await writeLine(zoneCommand)
    await zoneReply

    return { sent: sent.slice(), lines: lines.slice() }
  } catch (error) {
    pending = undefined
    if (error instanceof BoardSyncError) throw error
    // 非预期异常：带上栈的前几帧，方便定位是流内部还是驱动层的问题。
    throw new BoardSyncError('internal', `串口同步失败：${describeUnexpected(error)}`, lines.slice())
  } finally {
    pending = undefined
    if (port !== undefined) {
      const detach = port.off ?? port.removeListener
      try {
        detach?.('data', onData)
        detach?.('error', onError)
      } catch {
        /* 已经坏掉的流，detach 也可能抛，忽略即可 */
      }
      await closeSerialPort(port)
    }
  }
}

/** 打开失败时给人看的原因：把「被别的程序占着」说清楚，别只丢一个 Access denied。 */
function openFailureMessage(path: string, error: Error): string {
  const detail = error.message
  if (/access is denied|access denied|拒绝访问|被拒绝/i.test(detail)) {
    return `打开串口 ${path} 失败：端口被占用，请关闭串口监视器 / 烧录工具后重试（${detail}）`
  }
  return `打开串口 ${path} 失败：${detail}`
}

/** 非预期异常的简短描述（类型 + 消息 + 栈顶一帧）。 */
function describeUnexpected(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const frame = (error.stack ?? '').split('\n').find((line) => line.trim().startsWith('at '))
  return frame === undefined ? `${error.name}: ${error.message}` : `${error.name}: ${error.message} (${frame.trim()})`
}

/**
 * 关闭端口：正常 close 走回调；回调一直不来或流已经半死时用 `destroy()` 兜底。
 * 无论走哪条路都只 resolve 一次，不会把异常再抛给调用方。
 */
function closeSerialPort(port: SerialPortInstance): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve()
    }
    const destroy = (): void => {
      try {
        port.destroy?.()
      } catch {
        /* 端口可能已经没了，忽略 */
      }
    }
    const timer = setTimeout(() => {
      destroy()
      finish()
    }, 1000)
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

/* ------------------------------------------------------------------ *
 * PowerShell 兜底：一个脚本完成打开 / 写 / 读到匹配 / 关闭
 * ------------------------------------------------------------------ */

const DELIMITER = '@@AR1:'

const POWERSHELL_SYNC_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$sp = New-Object System.IO.Ports.SerialPort
$sp.PortName = $env:AIRREMOTE_PS_PORT
$sp.BaudRate = [int]$env:AIRREMOTE_PS_BAUD
$sp.Parity = [System.IO.Ports.Parity]::None
$sp.DataBits = 8
$sp.StopBits = [System.IO.Ports.StopBits]::One
$sp.Handshake = [System.IO.Ports.Handshake]::None
$sp.NewLine = [string][char]10
$sp.ReadTimeout = 200
$sp.WriteTimeout = 1000

function Emit([string]$tag, [string]$text) {
  [Console]::Out.WriteLine('@@AR1:' + $tag + '@@' + $text)
}

function Send-Wait([string]$command, [string]$okPattern, [string]$errPattern, [int]$timeoutMs) {
  try {
    $sp.WriteLine($command)
  } catch {
    Emit 'ERROR' ('write-failed:' + $_.Exception.Message)
    return 'error'
  }
  Emit 'SENT' $command
  $deadline = [DateTime]::UtcNow.AddMilliseconds($timeoutMs)
  $buffer = ''
  while ([DateTime]::UtcNow -lt $deadline) {
    $chunk = ''
    try { $chunk = $sp.ReadExisting() } catch { $chunk = '' }
    if ($chunk.Length -gt 0) {
      $buffer += $chunk
      $index = $buffer.IndexOf([char]10)
      while ($index -ge 0) {
        $line = $buffer.Substring(0, $index).Trim()
        $buffer = $buffer.Substring($index + 1)
        if ($line.Length -gt 0) {
          Emit 'LINE' $line
          if ($line -match $okPattern) { return 'ok' }
          if ($line -match $errPattern) { return 'err' }
        }
        $index = $buffer.IndexOf([char]10)
      }
    }
    Start-Sleep -Milliseconds 40
  }
  return 'timeout'
}

try { $sp.Open() } catch {
  Emit 'ERROR' ('open-failed:' + $_.Exception.Message)
  exit 2
}

$state = 'ok'
try {
  $state = Send-Wait ('AR1T ' + $env:AIRREMOTE_PS_UNIX) '^AR1T OK' '^AR1T ERR' 3000
  if ($state -eq 'ok') {
    $state = Send-Wait ('AR1Z ' + $env:AIRREMOTE_PS_MINUTES) '^AR1Z OK' '^AR1Z ERR' 3000
  }
} finally {
  if ($sp.IsOpen) { try { $sp.Close() } catch { } }
}

if ($state -eq 'timeout') { exit 3 }
if ($state -eq 'err') { exit 4 }
if ($state -eq 'error') { exit 1 }
exit 0
`

async function syncWithPowerShell(path: string, unixSeconds: number, minutes: number): Promise<BoardSyncResult> {
  const result = await runPowerShell(
    POWERSHELL_SYNC_SCRIPT,
    {
      AIRREMOTE_PS_PORT: path,
      AIRREMOTE_PS_BAUD: String(BOARD_BAUD_RATE),
      AIRREMOTE_PS_UNIX: String(unixSeconds),
      AIRREMOTE_PS_MINUTES: String(minutes)
    },
    POWERSHELL_TIMEOUT_MS
  )

  const sent: string[] = []
  const lines: string[] = []
  let openFailure = ''
  let writeFailure = ''

  for (const rawLine of result.stdout.split(/\r?\n/)) {
    const at = rawLine.indexOf(DELIMITER)
    if (at === -1) continue
    const rest = rawLine.slice(at + DELIMITER.length)
    const close = rest.indexOf('@@')
    if (close === -1) continue
    const tag = rest.slice(0, close)
    const text = rest.slice(close + 2)
    if (tag === 'SENT') sent.push(text)
    else if (tag === 'LINE') lines.push(text)
    else if (tag === 'ERROR') {
      if (text.startsWith('open-failed:')) openFailure = text.slice('open-failed:'.length)
      else writeFailure = text
    }
  }

  if (openFailure !== '') throw new BoardSyncError('open-failed', `打开串口 ${path} 失败：${openFailure}`, lines)
  if (writeFailure !== '') throw new BoardSyncError('internal', `写串口失败：${writeFailure}`, lines)

  if (result.exitCode === 2) throw new BoardSyncError('open-failed', `打开串口 ${path} 失败`, lines)
  if (result.exitCode === 3) {
    throw new BoardSyncError('timeout', `等待 ${sent.at(-1) ?? 'AR1T'} 的回包超时`, lines)
  }
  if (result.exitCode === 4) {
    throw new BoardSyncError('rejected', '开发板拒绝了时间命令（AR1T ERR / AR1Z ERR）', lines)
  }
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() !== '' ? result.stderr.trim() : `退出码 ${String(result.exitCode)}`
    throw new BoardSyncError('internal', `串口脚本失败：${detail}`, lines)
  }
  return { sent, lines }
}

interface PowerShellResult {
  stdout: string
  stderr: string
  exitCode: number
}

/**
 * 跑一次 PowerShell（`powershell.exe` 在 Windows 上一定存在，pwsh 不一定）。
 * 用环境变量传参，避免把端口名拼进脚本引起转义问题。
 */
function runPowerShell(script: string, env: Record<string, string>, timeoutMs: number): Promise<PowerShellResult> {
  return new Promise<PowerShellResult>((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      {
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, ...env }
      },
      (error, stdout, stderr) => {
        const code = (error as { code?: unknown } | null)?.code
        if (error !== null && typeof code === 'string') {
          reject(new BoardSyncError('internal', `无法启动 PowerShell（${code}）：${error.message}`))
          return
        }
        resolve({
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          exitCode: error === null ? 0 : Number(code ?? 1)
        })
      }
    )
  })
}
