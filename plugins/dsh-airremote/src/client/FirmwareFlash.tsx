import type { IEspLoaderTerminal, Transport as EsptoolTransport } from 'esptool-js'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

/**
 * Browser-side firmware flashing for the bundled merged image.
 *
 * Web Serial API notes (esptool-js 0.7.1, verified against
 * `node_modules/esptool-js/lib/*.d.ts` and `lib/*.js`):
 *
 *  - `new Transport(port, true)` takes the `SerialPort` and a tracing flag.
 *  - `new ESPLoader({ transport, baudrate: 460800, terminal })`; `loader.main()`
 *    returns the chip description string (for this board: "ESP32-C6
 *    (revision v0.1)"), so callers must validate it against the C6 family.
 *  - `flashOptions.fileArray[].data` is a **Uint8Array** in 0.7.1 (older
 *    examples used a binary string); `calculateMD5Hash` is optional, not a
 *    required callback. We deliberately omit it: the image is already checked
 *    against the manifest's SHA-256 before the serial port is touched.
 *  - `reportProgress(fileIndex, written, total)` reports uncompressed bytes.
 *  - `loader.after('hard_reset')` is the 0.7.1 hard-reset entry point.
 *
 * The module is imported lazily so the ~500 KB esptool bundle is not part of
 * the first paint. esptool-js 0.7.1 no longer references Node's `Buffer` at all
 * (grep of lib/*.js), so no `buffer` polyfill is required; if a future release
 * reintroduces it, polyfill `globalThis.Buffer` before the dynamic import.
 */

declare global {
  interface SerialPortInfo {
    usbVendorId?: number
    usbProductId?: number
  }
  interface SerialPort {
    getInfo(): SerialPortInfo
    open(options: { baudRate: number }): Promise<void>
    close(): Promise<void>
    readable: ReadableStream<Uint8Array> | null
    writable: WritableStream<Uint8Array> | null
  }
  interface SerialPortFilter {
    usbVendorId?: number
    usbProductId?: number
  }
  interface SerialPortRequestOptions {
    filters?: SerialPortFilter[]
  }
  interface Serial {
    requestPort(options?: SerialPortRequestOptions): Promise<SerialPort>
    getPorts(): Promise<SerialPort[]>
  }
  interface Navigator {
    readonly serial?: Serial
  }
}

const ESPRESSIF_VID = 0x303a
const FLASH_BAUDRATE = 460800
const MAX_LOG_LINES = 200
const DISCONNECT_TIMEOUT_MS = 5000
const SUPPORTED_CHIP = 'esp32c6'
const WEB_SERIAL_UNSUPPORTED =
  '当前环境不支持 Web Serial：请用 Chrome/Edge 打开 http://127.0.0.1:57648（DSH 桌面窗口禁用了 Web Serial）'
const NVS_WARNING =
  '合并固件从 0x0 整体写入，会覆盖 nvs 分区：烧录会清除开发板上的 Wi-Fi 配网与时区设置，烧录后需重新配网并再次同步时间。'

interface FirmwareManifest {
  version: string
  commit?: string
  builtAt?: string
  size: number
  sha256: string
  chip: string
  flashOffset: number
}

interface HoldResponse {
  ok?: boolean
  holder?: string
  error?: string
  message?: string
}

interface StatusLine {
  tone: 'info' | 'ok' | 'error'
  text: string
  retry?: boolean
}

interface FlashProgress {
  phase: string
  percent: number
  written: number
  total: number
}

type FlashFailureKind = 'image' | 'sha' | 'busy' | 'chip' | 'timeout' | 'disconnected' | 'other'

class FlashFailure extends Error {
  readonly kind: FlashFailureKind

  constructor(kind: FlashFailureKind, message: string) {
    super(message)
    this.name = 'FlashFailure'
    this.kind = kind
  }
}

type EsptoolModule = typeof import('esptool-js')

let esptoolPromise: Promise<EsptoolModule> | null = null

async function loadEsptool(): Promise<EsptoolModule> {
  if (esptoolPromise === null) esptoolPromise = import('esptool-js')
  return await esptoolPromise
}

function getSerial(): Serial | undefined {
  if (typeof navigator === 'undefined') return undefined
  return navigator.serial
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message === '' ? error.name : error.message
  return typeof error === 'string' ? error : '未知错误'
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '未知'
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

function formatBuiltAt(value: string | undefined): string {
  if (value === undefined || value === '') return '未知'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString()
}

function formatUsbId(value: number | undefined): string {
  if (typeof value !== 'number') return '未知'
  return `0x${value.toString(16).padStart(4, '0')}`
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** "ESP32-C6 (revision v0.1)" and "unknown ESP32-C6 ..." pass; ESP32-C61 does not. */
function isEsp32C6(chip: string): boolean {
  return /ESP32-C6\b/i.test(chip)
}

function describeFailure(error: unknown): { text: string; reselect: boolean } {
  if (error instanceof FlashFailure) {
    switch (error.kind) {
      case 'image':
        return { text: `${error.message}，请稍后重试。`, reselect: false }
      case 'sha':
        return { text: '固件文件损坏（sha256 不匹配）', reselect: false }
      case 'busy':
        return { text: '串口正被其它操作占用，请结束时间同步等操作后重试。', reselect: false }
      case 'chip':
        return { text: error.message, reselect: false }
      case 'timeout':
        return { text: '烧录超时：开发板没有在预期时间内响应，请检查 USB 线材与供电后重试。', reselect: false }
      case 'disconnected':
        return { text: '串口连接已断开（开发板可能被拔出），请重新插拔开发板并重新选择串口后重试。', reselect: true }
      default:
        return { text: `烧录失败：${error.message}`, reselect: false }
    }
  }

  const name = error instanceof Error ? error.name : ''
  const message = errorText(error)
  const lower = message.toLowerCase()

  if (name === 'TimeoutError' || lower.includes('timeout') || lower.includes('timed out')) {
    return { text: '烧录超时：开发板没有在预期时间内响应，请检查 USB 线材与供电后重试。', reselect: false }
  }
  if (
    name === 'NotFoundError' ||
    name === 'NetworkError' ||
    lower.includes('serial port closed') ||
    lower.includes('device has been lost') ||
    lower.includes('device lost') ||
    lower.includes('disconnected')
  ) {
    return { text: '串口连接已断开（串口掉线），请重新插拔开发板并重新选择串口后重试。', reselect: true }
  }
  if (lower.includes('failed to connect') || lower.includes('no serial data received')) {
    return { text: '无法连接开发板：请确认串口未被其它程序占用、开发板已进入下载模式后重试。', reselect: false }
  }
  return { text: `烧录失败：${message === '' ? '未知错误' : message}`, reselect: false }
}

function parseManifest(value: unknown): FirmwareManifest | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  if (typeof record.version !== 'string' || record.version === '') return null
  if (typeof record.size !== 'number' || !Number.isFinite(record.size) || record.size <= 0) return null
  if (typeof record.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(record.sha256)) return null
  return {
    version: record.version,
    commit: typeof record.commit === 'string' ? record.commit : undefined,
    builtAt: typeof record.builtAt === 'string' ? record.builtAt : undefined,
    size: record.size,
    sha256: record.sha256,
    chip: typeof record.chip === 'string' && record.chip !== '' ? record.chip : SUPPORTED_CHIP,
    flashOffset: typeof record.flashOffset === 'number' ? record.flashOffset : 0
  }
}

async function setSerialHolder(holder: 'flash' | 'none'): Promise<HoldResponse> {
  const response = await fetch('/airremote/serial-hold', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ holder })
  })
  const data = (await response.json().catch(() => ({}))) as HoldResponse
  if (!response.ok && data.ok !== false) {
    return { ok: false, error: `http-${response.status}`, message: `HTTP ${response.status}` }
  }
  return data
}

async function disconnectTransport(transport: EsptoolTransport, log: (line: string) => void): Promise<void> {
  const pending = transport.disconnect().catch((error: unknown) => {
    log(`!!! 关闭串口失败：${errorText(error)}`)
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      log('!!! 关闭串口超时（5 秒），继续释放串口占用')
      resolve()
    }, DISCONNECT_TIMEOUT_MS)
  })
  try {
    await Promise.race([pending, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Settings section: shows the bundled firmware manifest and flashes it through
 * Web Serial only after an explicit button press. No mount-time serial access,
 * no polling, no hot-plug listeners — selecting a port and flashing are both
 * user gestures, and the host-side serial holder is released in `finally`.
 */
export function FirmwareFlash() {
  const [manifest, setManifest] = useState<FirmwareManifest | null>(null)
  const [manifestError, setManifestError] = useState<string | null>(null)
  const [port, setPort] = useState<SerialPort | null>(null)
  const [portInfo, setPortInfo] = useState<SerialPortInfo | null>(null)
  const [selecting, setSelecting] = useState(false)
  const [flashing, setFlashing] = useState(false)
  const [eraseAll, setEraseAll] = useState(false)
  const [progress, setProgress] = useState<FlashProgress | null>(null)
  const [status, setStatus] = useState<StatusLine | null>(null)
  const [lines, setLines] = useState<string[]>([])

  const logLinesRef = useRef<string[]>([])
  const partialLineRef = useRef('')
  const logBoxRef = useRef<HTMLDivElement | null>(null)

  const publishLogs = useCallback(() => {
    const partial = partialLineRef.current
    const combined = partial === '' ? logLinesRef.current.slice() : [...logLinesRef.current, partial]
    setLines(combined.length > MAX_LOG_LINES ? combined.slice(combined.length - MAX_LOG_LINES) : combined)
  }, [])

  const appendLogText = useCallback(
    (text: string) => {
      if (text === '') return
      const parts = (partialLineRef.current + text).split('\n')
      partialLineRef.current = parts.pop() ?? ''
      const next = logLinesRef.current.concat(parts)
      logLinesRef.current = next.length > MAX_LOG_LINES ? next.slice(next.length - MAX_LOG_LINES) : next
      publishLogs()
    },
    [publishLogs]
  )

  const appendLine = useCallback((text: string) => appendLogText(`${text}\n`), [appendLogText])

  const clearLogs = useCallback(() => {
    logLinesRef.current = []
    partialLineRef.current = ''
    setLines([])
  }, [])

  useEffect(() => {
    const box = logBoxRef.current
    if (box !== null) box.scrollTop = box.scrollHeight
  }, [lines])

  const terminal = useMemo<IEspLoaderTerminal>(
    () => ({
      clean: clearLogs,
      writeLine: (data: string) => appendLine(data),
      write: (data: string) => appendLogText(data)
    }),
    [appendLine, appendLogText, clearLogs]
  )

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const response = await fetch('/airremote/firmware/manifest', {
          headers: { Accept: 'application/json' },
          cache: 'no-store'
        })
        const body = (await response.json().catch(() => null)) as unknown
        if (!alive) return
        if (!response.ok) {
          const record = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : null
          const message =
            record !== null && typeof record.message === 'string' ? record.message : `HTTP ${response.status}`
          setManifestError(message)
          return
        }
        const parsed = parseManifest(body)
        if (parsed === null) {
          setManifestError('固件清单格式不正确')
          return
        }
        setManifest(parsed)
      } catch (error) {
        if (!alive) return
        setManifestError(errorText(error))
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  const serial = getSerial()
  const webSerialAvailable = serial !== undefined
  const webCryptoAvailable = typeof crypto !== 'undefined' && crypto.subtle !== undefined
  const manifestChipOk = manifest !== null && manifest.chip.toLowerCase() === SUPPORTED_CHIP
  const canFlash =
    webSerialAvailable &&
    webCryptoAvailable &&
    manifest !== null &&
    manifestChipOk &&
    port !== null &&
    !flashing &&
    !selecting

  const handleSelectPort = useCallback(() => {
    const currentSerial = getSerial()
    if (currentSerial === undefined) {
      setStatus({ tone: 'error', text: WEB_SERIAL_UNSUPPORTED })
      return
    }
    if (selecting || flashing) return
    setSelecting(true)
    setStatus(null)
    void (async () => {
      try {
        const selected = await currentSerial.requestPort({ filters: [{ usbVendorId: ESPRESSIF_VID }] })
        const info = selected.getInfo()
        setPort(selected)
        setPortInfo(info)
        setStatus({ tone: 'ok', text: '已选择串口' })
      } catch (error) {
        const name = error instanceof Error ? error.name : ''
        if (name === 'NotFoundError') {
          setStatus({ tone: 'info', text: '未选择串口（已取消）' })
        } else if (name === 'SecurityError') {
          setStatus({
            tone: 'error',
            text: '浏览器阻止了串口访问：请用 Chrome/Edge 通过 http://127.0.0.1:57648 打开，并允许本站使用串口。'
          })
        } else if (name === 'NotAllowedError') {
          setStatus({ tone: 'error', text: '串口访问被拒绝：请在浏览器站点权限中允许「串口」，然后重试。' })
        } else {
          setStatus({ tone: 'error', text: `选择串口失败：${errorText(error)}` })
        }
      } finally {
        setSelecting(false)
      }
    })()
  }, [flashing, selecting])

  const handleFlash = useCallback(() => {
    if (flashing || selecting) return
    const currentManifest = manifest
    const currentPort = port
    if (currentManifest === null) {
      setStatus({ tone: 'error', text: '内置固件不可用，无法烧录。' })
      return
    }
    if (!manifestChipOk) {
      setStatus({ tone: 'error', text: `固件清单芯片为「${currentManifest.chip}」，与 ESP32-C6 不匹配，已禁用烧录。` })
      return
    }
    if (currentPort === null) {
      setStatus({ tone: 'error', text: '请先选择串口。' })
      return
    }
    if (!webCryptoAvailable) {
      setStatus({ tone: 'error', text: '当前环境不支持 WebCrypto SHA-256，无法校验固件。' })
      return
    }

    setFlashing(true)
    setProgress(null)
    setStatus({ tone: 'info', text: '正在下载并校验固件…' })
    clearLogs()

    void (async () => {
      let transport: EsptoolTransport | null = null
      let holdAcquired = false
      try {
        appendLine(
          `>>> 固件 v${currentManifest.version} · ${formatBytes(currentManifest.size)} · sha256 ${currentManifest.sha256.slice(0, 8)}…`
        )

        const imageResponse = await fetch('/airremote/firmware/image', { cache: 'no-store' })
        if (!imageResponse.ok) {
          const body = (await imageResponse.json().catch(() => null)) as { message?: unknown } | null
          const message =
            body !== null && typeof body.message === 'string' ? body.message : `HTTP ${imageResponse.status}`
          throw new FlashFailure('image', `下载固件失败：${message}`)
        }
        const imageBuffer = await imageResponse.arrayBuffer()
        const digest = await crypto.subtle.digest('SHA-256', imageBuffer)
        const actualSha256 = toHex(digest)
        appendLine(`>>> 本地校验 sha256：${actualSha256}`)
        if (actualSha256 !== currentManifest.sha256) {
          appendLine(`!!! 期望 sha256：${currentManifest.sha256}`)
          throw new FlashFailure('sha', '固件文件损坏（sha256 不匹配）')
        }
        if (imageBuffer.byteLength !== currentManifest.size) {
          appendLine(`!!! 清单大小 ${currentManifest.size} 字节，实际 ${imageBuffer.byteLength} 字节`)
          throw new FlashFailure('sha', '固件文件损坏（大小不匹配）')
        }
        appendLine('>>> sha256 与清单一致，固件完整')

        const confirmed = window.confirm(
          `即将烧录固件 v${currentManifest.version}\n` +
            `sha256：${currentManifest.sha256.slice(0, 8)}…\n` +
            `芯片：${currentManifest.chip}\n\n` +
            '将覆盖开发板上的固件。烧录会清除开发板上的 Wi-Fi 配网与时区设置，烧录后需重新配网并再次同步时间。\n\n' +
            '过程中请勿拔线。确定继续？'
        )
        if (!confirmed) {
          setStatus({ tone: 'info', text: '已取消烧录' })
          return
        }

        setStatus({ tone: 'info', text: '正在占用串口…' })
        const hold = await setSerialHolder('flash')
        if (hold.ok !== true) {
          throw new FlashFailure('busy', hold.message ?? '串口正被其它操作占用')
        }
        holdAcquired = true
        appendLine('>>> 已获得串口占用权（holder=flash）')

        const { ESPLoader, Transport } = await loadEsptool()
        transport = new Transport(currentPort, true)
        const loader = new ESPLoader({
          transport,
          baudrate: FLASH_BAUDRATE,
          terminal
        })

        setStatus({ tone: 'info', text: '正在连接开发板…' })
        const chip = await loader.main()
        appendLine(`>>> 检测到芯片：${chip}`)
        if (!isEsp32C6(chip)) {
          throw new FlashFailure('chip', `检测到芯片「${chip}」，不是 ESP32-C6 系列，已中止烧录。`)
        }

        setStatus({
          tone: 'info',
          text: eraseAll ? '正在整片擦除并写入固件（整片擦除较慢，请勿断电）…' : '正在写入固件…'
        })
        await loader.writeFlash({
          // 0.7.1: data is Uint8Array, not a binary string.
          fileArray: [{ data: new Uint8Array(imageBuffer), address: 0x0 }],
          flashSize: 'keep',
          flashMode: 'keep',
          flashFreq: 'keep',
          eraseAll,
          compress: true,
          reportProgress: (_fileIndex: number, written: number, total: number) => {
            const percent = total > 0 ? Math.min(100, Math.round((written / total) * 100)) : 0
            setProgress({ phase: '写入中', percent, written, total })
          }
        })
        appendLine('>>> 固件写入完成')

        try {
          await loader.after('hard_reset')
          appendLine('>>> 已发送硬复位命令')
        } catch (resetError) {
          appendLine(`!!! 硬复位失败：${errorText(resetError)}`)
        }

        setProgress({
          phase: '完成',
          percent: 100,
          written: imageBuffer.byteLength,
          total: imageBuffer.byteLength
        })
        setStatus({
          tone: 'ok',
          text: `烧录完成 · 固件 v${currentManifest.version}；请重新配网并再次同步时间。`
        })
      } catch (error) {
        const failure = describeFailure(error)
        appendLine(`!!! ${failure.text}`)
        setStatus({ tone: 'error', text: failure.text, retry: true })
        setProgress(null)
        if (failure.reselect) {
          setPort(null)
          setPortInfo(null)
        }
      } finally {
        // Always close the browser-side port first, then hand the host back its
        // serial holder. Both steps run even when the user aborts or esptool
        // throws, so a failed flash never leaves the board locked.
        if (transport !== null) {
          await disconnectTransport(transport, appendLine)
        }
        if (holdAcquired) {
          try {
            const released = await setSerialHolder('none')
            if (released.ok === true) {
              appendLine('>>> 已释放串口占用（holder=none）')
            } else {
              appendLine(`!!! 释放串口占用失败：${released.message ?? released.error ?? '未知错误'}`)
            }
          } catch (error) {
            appendLine(`!!! 释放串口占用失败：${errorText(error)}`)
          }
        }
        setFlashing(false)
      }
    })()
  }, [
    appendLine,
    clearLogs,
    eraseAll,
    flashing,
    manifest,
    manifestChipOk,
    port,
    selecting,
    terminal,
    webCryptoAvailable
  ])

  const handleRetry = useCallback(() => {
    if (flashing || selecting) return
    setStatus(null)
    setProgress(null)
    if (port === null) {
      handleSelectPort()
      return
    }
    handleFlash()
  }, [flashing, handleFlash, handleSelectPort, port, selecting])

  const controlStyle = {
    fontSize: '12px',
    padding: '4px 10px',
    borderRadius: '6px',
    border: '1px solid rgba(127, 127, 127, 0.4)',
    background: 'rgba(127, 127, 127, 0.12)',
    color: 'inherit'
  } as const

  const mutedStyle = { fontSize: '12px', opacity: 0.6 } as const
  const sha256Short = manifest === null ? '' : manifest.sha256.slice(0, 8)

  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: '10px', padding: '4px 2px' }}>
      <div style={{ fontSize: '13px', fontWeight: 600 }}>固件烧录</div>

      {manifestError !== null ? (
        <div style={mutedStyle}>内置固件不可用：{manifestError}</div>
      ) : manifest === null ? (
        <div style={mutedStyle}>正在读取内置固件信息…</div>
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'auto 1fr',
            columnGap: '12px',
            rowGap: '3px',
            fontSize: '12px'
          }}
        >
          <span style={{ opacity: 0.65 }}>版本</span>
          <span style={{ fontWeight: 600 }}>固件 v{manifest.version}</span>
          <span style={{ opacity: 0.65 }}>构建时间</span>
          <span>{formatBuiltAt(manifest.builtAt)}</span>
          <span style={{ opacity: 0.65 }}>大小</span>
          <span>{formatBytes(manifest.size)}</span>
          <span style={{ opacity: 0.65 }}>sha256</span>
          <span title={manifest.sha256}>
            {sha256Short}
            <span style={{ opacity: 0.6 }}>…</span>
          </span>
          <span style={{ opacity: 0.65 }}>芯片</span>
          <span>{manifest.chip}</span>
        </div>
      )}

      {manifest !== null && !manifestChipOk ? (
        <div style={{ fontSize: '12px', color: '#e5534b' }}>
          固件清单芯片为「{manifest.chip}」，与 ESP32-C6 不匹配，已禁用烧录。
        </div>
      ) : null}

      <div style={{ fontSize: '11px', opacity: 0.6, lineHeight: 1.55 }}>{NVS_WARNING}</div>

      {!webSerialAvailable ? (
        <div
          role="status"
          style={{
            fontSize: '12px',
            lineHeight: 1.55,
            padding: '6px 8px',
            borderRadius: '6px',
            background: 'rgba(229, 83, 75, 0.1)',
            color: '#e5534b'
          }}
        >
          {WEB_SERIAL_UNSUPPORTED}
        </div>
      ) : null}

      {!webCryptoAvailable && webSerialAvailable ? (
        <div style={{ fontSize: '12px', color: '#e5534b' }}>
          当前环境不支持 WebCrypto SHA-256，无法校验固件，已禁用烧录。
        </div>
      ) : null}

      <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
        <button
          type="button"
          disabled={!webSerialAvailable || flashing || selecting}
          onClick={handleSelectPort}
          style={{
            ...controlStyle,
            cursor: !webSerialAvailable || flashing || selecting ? 'default' : 'pointer',
            opacity: !webSerialAvailable || flashing || selecting ? 0.6 : 1
          }}
        >
          {selecting ? '选择中…' : '选择串口'}
        </button>
        <button
          type="button"
          disabled={!canFlash}
          onClick={handleFlash}
          style={{ ...controlStyle, cursor: canFlash ? 'pointer' : 'default', opacity: canFlash ? 1 : 0.6 }}
        >
          {flashing ? '烧录中…' : '烧录'}
        </button>
        {portInfo === null ? null : (
          <span style={{ fontSize: '12px', opacity: 0.7 }}>
            串口 VID {formatUsbId(portInfo.usbVendorId)} · PID {formatUsbId(portInfo.usbProductId)}
          </span>
        )}
      </div>

      <label
        style={{
          display: 'flex',
          gap: '6px',
          alignItems: 'flex-start',
          fontSize: '12px',
          opacity: flashing ? 0.6 : 1
        }}
      >
        <input
          type="checkbox"
          checked={eraseAll}
          disabled={flashing}
          onChange={(event) => setEraseAll(event.target.checked)}
          style={{ marginTop: '2px' }}
        />
        <span>擦除整片（会清空开发板上的 NVS、配网与校准数据）</span>
      </label>
      {eraseAll ? (
        <div style={{ fontSize: '11px', color: '#e5534b', lineHeight: 1.5 }}>
          ⚠️ 已启用整片擦除：开发板上的 Wi-Fi 配网、时区设置和校准数据都会被清除，且无法恢复。
        </div>
      ) : null}

      {progress === null ? null : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center', fontSize: '12px' }}>
            <span>
              {progress.phase} · {progress.percent}%
            </span>
            <span style={{ opacity: 0.6 }}>
              {formatBytes(progress.written)} / {formatBytes(progress.total)}
            </span>
          </div>
          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress.percent}
            style={{ height: '6px', borderRadius: '3px', background: 'rgba(127, 127, 127, 0.2)', overflow: 'hidden' }}
          >
            <div
              style={{
                height: '100%',
                width: `${progress.percent}%`,
                background: '#4c8bf5',
                transition: 'width 120ms linear'
              }}
            />
          </div>
        </div>
      )}

      {status === null ? null : (
        <div
          role="status"
          aria-live="polite"
          style={{
            display: 'flex',
            gap: '8px',
            alignItems: 'center',
            flexWrap: 'wrap',
            fontSize: '12px',
            opacity: status.tone === 'info' ? 0.7 : 0.95,
            color: status.tone === 'error' ? '#e5534b' : 'inherit'
          }}
        >
          <span>{status.text}</span>
          {status.retry === true && !flashing ? (
            <button
              type="button"
              onClick={handleRetry}
              style={{ ...controlStyle, padding: '2px 8px', cursor: 'pointer' }}
            >
              重试
            </button>
          ) : null}
        </div>
      )}

      {lines.length === 0 ? null : (
        <div
          ref={logBoxRef}
          style={{
            maxHeight: '180px',
            overflow: 'auto',
            border: '1px solid rgba(127, 127, 127, 0.25)',
            borderRadius: '6px',
            padding: '6px 8px',
            background: 'rgba(127, 127, 127, 0.08)',
            fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
            fontSize: '11px',
            lineHeight: 1.45,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all'
          }}
        >
          {lines.map((line, index) => (
            <div key={index}>{line === '' ? '\u00a0' : line}</div>
          ))}
        </div>
      )}
    </section>
  )
}
