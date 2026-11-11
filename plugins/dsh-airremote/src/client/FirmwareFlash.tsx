import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * 「固件烧录」设置区块：浏览器端只负责展示固件身份、发起 / 取消烧录、渲染进度与日志；
 * 真正碰串口的烧录由宿主（Node 侧，同源 `/airremote/flash` WebSocket 路由）执行。
 *
 * 为什么不再用浏览器 Web Serial：DSH 桌面窗口是 Electron，宿主显式设置了
 * `setDevicePermissionHandler(() => false)`，浏览器侧的 Web Serial API 拿不到任何串口；
 * 而正式插件必须自包含，不能要求用户另开浏览器。宿主本来就有 serialport 依赖和
 * 串口占用协调（`/airremote/serial-hold`），把烧录放宿主既可用，也不会和「时间同步」抢串口。
 *
 * 固定协议：
 *   浏览器 → 宿主：{type:'start'} / {type:'cancel'}
 *   宿主 → 浏览器：
 *     {type:'state', phase:'idle'|'running'|'done'|'error'|'cancelled'}
 *     {type:'log', line}
 *     {type:'progress', percent, written, total}
 *     {type:'done', port, seconds}
 *     {type:'error', code, message}
 *     {type:'ping', at}
 *
 * 多连接语义：宿主允许同时挂多条 WS，设置页这条只是「观察者 + 可操作者」。
 * 已有烧录在跑时再发 start 会收到 `{type:'error', code:'busy'}`，但**连接不再断开**，
 * 所以它按普通错误显示、并保持可重试；`ping` 等未知 / 心跳消息一律静默忽略。
 *
 * 挂载只做两件事：GET `/airremote/firmware/manifest`、建立**一次** WS。不自动烧录、
 * 不轮询、不监听插拔；断线后只有用户点「重新连接」才会重连。
 */

const MAX_LOG_LINES = 200
const SUPPORTED_CHIP = 'esp32c6'
const FLASH_WS_PATH = '/airremote/flash'
const NVS_WARNING =
  '合并固件从 0x0 整体写入，会覆盖 nvs 分区：烧录会清除开发板上的 Wi-Fi 配网与时区设置，烧录后需重新配网并再次同步时间。'
const NVS_CONFIRM = '烧录会清除开发板上的 Wi-Fi 配网与时区设置，烧录后需重新配网并再次同步时间。'
/** 取消烧录的二次确认：中途中断会留下写了一半的固件，板子起不来。 */
const CANCEL_CONFIRM = '中断烧录会清空 flash，开发板将无法启动，必须重新烧录才能恢复。确定中断？'
/** 取消后的状态文案：强调板子当前不可启动，引导用户立刻重烧。 */
const CANCELLED_TEXT = '烧录已中断，开发板处于不可启动状态，请重新烧录'
/** 取消按钮旁边的小字，提前告知后果。 */
const CANCEL_HINT = '中断烧录会让开发板无法启动，需重新烧录才能恢复'

interface FirmwareManifest {
  version: string
  builtAt?: string
  size: number
  sha256: string
  chip: string
}

/** 宿主回报的烧录阶段。`busy` 表示宿主侧已有一次烧录在跑。 */
type ServerPhase = 'idle' | 'busy' | 'running' | 'done' | 'error' | 'cancelled'

type Connection = 'connecting' | 'open' | 'closed'

type Status =
  | { kind: 'info'; text: string }
  | { kind: 'error'; text: string }
  | { kind: 'done'; port: string; seconds: number | null }

interface Progress {
  percent: number
  written: number
  total: number
}

/** 宿主 error code → 中文。没有列出的 code（含 `internal`）直接用宿主的 message。 */
const ERROR_TEXT: Record<string, string> = {
  'no-board': '未找到开发板（USB VID 303A）',
  'open-failed': '串口打不开（可能被占用）',
  timeout: '板子没有响应',
  rejected: '板子拒绝了命令',
  busy: '串口正被占用',
  'sha256-mismatch': '固件文件损坏（sha256 不匹配）',
  cancelled: '已取消'
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

function formatSeconds(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return '耗时未知'
  return `${seconds.toFixed(1)}s`
}

function describeError(code: string, message: string): string {
  const known = ERROR_TEXT[code]
  if (known !== undefined) return known
  const trimmed = message.trim()
  return trimmed === '' ? '烧录失败' : trimmed
}

function parseManifest(value: unknown): FirmwareManifest | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  if (typeof record.version !== 'string' || record.version === '') return null
  if (typeof record.size !== 'number' || !Number.isFinite(record.size) || record.size <= 0) return null
  if (typeof record.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(record.sha256)) return null
  return {
    version: record.version,
    builtAt: typeof record.builtAt === 'string' ? record.builtAt : undefined,
    size: record.size,
    sha256: record.sha256,
    chip: typeof record.chip === 'string' && record.chip !== '' ? record.chip : SUPPORTED_CHIP
  }
}

function readPhase(value: unknown): ServerPhase | null {
  if (value === 'idle' || value === 'running' || value === 'done') return value
  if (value === 'busy' || value === 'error' || value === 'cancelled') return value
  return null
}

/**
 * 设置区块：只有「固件身份 + 开始/取消 + 进度 + 日志」。
 * 串口选择、VID/PID、擦除整片这些都属于宿主侧决策，浏览器不再参与。
 */
export function FirmwareFlash() {
  const [manifest, setManifest] = useState<FirmwareManifest | null>(null)
  const [manifestError, setManifestError] = useState<string | null>(null)
  const [connection, setConnection] = useState<Connection>('connecting')
  const [phase, setPhase] = useState<ServerPhase>('idle')
  const [startSent, setStartSent] = useState(false)
  const [cancelSent, setCancelSent] = useState(false)
  const [progress, setProgress] = useState<Progress | null>(null)
  const [status, setStatus] = useState<Status | null>(null)
  const [lines, setLines] = useState<string[]>([])

  const socketRef = useRef<WebSocket | null>(null)
  const logBoxRef = useRef<HTMLDivElement | null>(null)

  const appendLine = useCallback((line: string) => {
    setLines((previous) => {
      const next = previous.concat(line)
      return next.length > MAX_LOG_LINES ? next.slice(next.length - MAX_LOG_LINES) : next
    })
  }, [])

  /** 处理宿主推来的每一条消息；只依赖稳定的 setter，因此引用恒定。 */
  const handleServerMessage = useCallback(
    (raw: unknown) => {
      if (typeof raw !== 'string') return
      let value: unknown
      try {
        value = JSON.parse(raw)
      } catch {
        return
      }
      if (typeof value !== 'object' || value === null) return
      const message = value as Record<string, unknown>

      switch (message.type) {
        case 'state': {
          const next = readPhase(message.phase)
          if (next === null) return
          setPhase(next)
          setStartSent(false)
          setCancelSent(false)
          if (next === 'cancelled') setStatus({ kind: 'error', text: CANCELLED_TEXT })
          return
        }
        case 'busy': {
          // 旧版宿主「连接建立就 busy 然后断开」的通知；新宿主改为 error+busy 且不断开。
          // 保留处理只为兼容旧宿主，不产生额外副作用。
          setPhase('busy')
          setStartSent(false)
          const detail = typeof message.message === 'string' ? message.message.trim() : ''
          setStatus({ kind: 'error', text: detail === '' ? '宿主侧已有烧录在进行中，请等它结束后重试。' : detail })
          return
        }
        case 'log': {
          if (typeof message.line !== 'string') return
          appendLine(message.line)
          return
        }
        case 'progress': {
          const written = typeof message.written === 'number' && Number.isFinite(message.written) ? message.written : 0
          const total = typeof message.total === 'number' && Number.isFinite(message.total) ? message.total : 0
          const computed = total > 0 ? Math.round((written / total) * 100) : 0
          const rawPercent =
            typeof message.percent === 'number' && Number.isFinite(message.percent) ? message.percent : computed
          const percent = Math.max(0, Math.min(100, Math.round(rawPercent)))
          setProgress({ percent, written, total })
          return
        }
        case 'done': {
          const port = typeof message.port === 'string' && message.port !== '' ? message.port : '未知串口'
          const seconds =
            typeof message.seconds === 'number' && Number.isFinite(message.seconds) ? message.seconds : null
          setPhase('done')
          setStartSent(false)
          setCancelSent(false)
          setProgress((previous) => (previous === null ? previous : { ...previous, percent: 100 }))
          setStatus({ kind: 'done', port, seconds })
          return
        }
        case 'error': {
          const code = typeof message.code === 'string' ? message.code : 'internal'
          const hostMessage = typeof message.message === 'string' ? message.message.trim() : ''
          // code=busy 现在会在**连接仍然存在**时返回（另一个连接正在烧录）。
          // 宿主给的原话（「已有一次烧录在进行，请等它结束」）比通用文案更准确，
          // 但仍按普通错误显示，`showRetry` 会给出「重试」。
          const text = code === 'busy' && hostMessage !== '' ? hostMessage : describeError(code, hostMessage)
          setStartSent(false)
          setCancelSent(false)
          if (code === 'cancelled') {
            // 中断后板子写了一半、起不来：状态是 error（不是「已取消」的普通提示），
            // 但 phase 保持 cancelled → inFlight=false → 「烧录」按钮立刻可用，能马上重烧恢复。
            setPhase('cancelled')
            setStatus({ kind: 'error', text: CANCELLED_TEXT })
            return
          }
          setPhase('error')
          setStatus({ kind: 'error', text })
          return
        }
        case 'ping': {
          // 宿主 15s 心跳：只保活，不参与 UI 状态。
          return
        }
        default:
          // 未知 type（未来协议扩展 / 旧宿主字段）静默忽略，绝不改变状态或报错。
          return
      }
    },
    [appendLine]
  )

  /**
   * 建一次连接。只有两种调用者：挂载时（一次）+ 用户点「重新连接」。
   * 没有重连定时器，onclose 之后不会再自己连回去。
   */
  const connect = useCallback(() => {
    const current = socketRef.current
    if (current !== null && (current.readyState === WebSocket.CONNECTING || current.readyState === WebSocket.OPEN)) return

    const url = `${location.protocol === 'https:' ? 'wss://' : 'ws://'}${location.host}${FLASH_WS_PATH}`
    let socket: WebSocket
    try {
      socket = new WebSocket(url)
    } catch (error) {
      setConnection('closed')
      setStatus({ kind: 'error', text: `连接烧录服务失败：${errorText(error)}` })
      return
    }

    socketRef.current = socket
    setConnection('connecting')
    setStatus(null)

    socket.onopen = () => {
      if (socketRef.current !== socket) return
      setConnection('open')
    }
    socket.onmessage = (event: MessageEvent) => {
      if (socketRef.current !== socket) return
      handleServerMessage(event.data)
    }
    // 出错后浏览器一定会再触发 onclose，断线状态统一在 onclose 里收口。
    socket.onerror = () => undefined
    socket.onclose = () => {
      if (socketRef.current !== socket) return
      socketRef.current = null
      setConnection('closed')
      setStartSent(false)
      setCancelSent(false)
    }
  }, [handleServerMessage])

  // 挂载：读 manifest（一次）。清理时不再回写状态。
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

  // 挂载：连一次 WS；卸载时只关闭自己那条连接。
  useEffect(() => {
    connect()
    return () => {
      const socket = socketRef.current
      socketRef.current = null
      if (socket === null) return
      socket.onopen = null
      socket.onmessage = null
      socket.onerror = null
      socket.onclose = null
      socket.close()
    }
  }, [connect])

  // 日志自动滚到底。
  useEffect(() => {
    const box = logBoxRef.current
    if (box !== null) box.scrollTop = box.scrollHeight
  }, [lines])

  /** 往宿主发一条指令；连接不在时给出可见提示而不是静默失败。 */
  const send = useCallback((payload: { type: string }): boolean => {
    const socket = socketRef.current
    if (socket === null || socket.readyState !== WebSocket.OPEN) {
      setStatus({ kind: 'error', text: '烧录服务未连接，请先点「重新连接」。' })
      return false
    }
    socket.send(JSON.stringify(payload))
    return true
  }, [])

  const manifestChipOk = manifest !== null && manifest.chip.toLowerCase() === SUPPORTED_CHIP
  const inFlight = phase === 'running' || startSent
  const canStart = connection === 'open' && manifest !== null && manifestChipOk && !inFlight
  const canCancel = connection === 'open' && phase === 'running' && !cancelSent

  const handleStart = useCallback(() => {
    const current = manifest
    if (current === null) {
      setStatus({ kind: 'error', text: '内置固件不可用，无法烧录。' })
      return
    }
    if (!manifestChipOk) {
      setStatus({ kind: 'error', text: `固件清单芯片为「${current.chip}」，与 ESP32-C6 不匹配，已禁用烧录。` })
      return
    }
    if (inFlight) return

    const confirmed = window.confirm(
      `即将烧录固件 v${current.version}\n` +
        `sha256：${current.sha256.slice(0, 8)}…\n` +
        `芯片：${SUPPORTED_CHIP}\n\n` +
        `将覆盖开发板上的固件。${NVS_CONFIRM}\n\n` +
        '过程中请勿拔线。确定继续？'
    )
    if (!confirmed) {
      setStatus({ kind: 'info', text: '已取消烧录' })
      return
    }

    setProgress(null)
    setLines([])
    setCancelSent(false)
    setStatus({ kind: 'info', text: '已发送烧录指令，等待宿主接管串口…' })
    if (!send({ type: 'start' })) return
    setStartSent(true)
  }, [inFlight, manifest, manifestChipOk, send])

  const handleCancel = useCallback(() => {
    if (!canCancel) return
    // 二次确认：中断烧录 = 板子上是写了一半的固件，起不来。用户取消就什么都不发。
    if (!window.confirm(CANCEL_CONFIRM)) return
    if (!send({ type: 'cancel' })) return
    setCancelSent(true)
    setStatus({ kind: 'info', text: '已发送中断请求，等待宿主结束烧录…' })
  }, [canCancel, send])

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
  const showRetry =
    connection === 'open' &&
    !inFlight &&
    manifest !== null &&
    (phase === 'error' || phase === 'cancelled' || (status !== null && status.kind === 'error'))

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

      {connection === 'closed' ? (
        <div
          role="status"
          style={{
            display: 'flex',
            gap: '8px',
            alignItems: 'center',
            flexWrap: 'wrap',
            fontSize: '12px',
            lineHeight: 1.55,
            padding: '6px 8px',
            borderRadius: '6px',
            background: 'rgba(229, 83, 75, 0.1)',
            color: '#e5534b'
          }}
        >
          <span>已断开，点「重新连接」</span>
          <button
            type="button"
            onClick={connect}
            style={{ ...controlStyle, padding: '2px 8px', cursor: 'pointer', color: 'inherit' }}
          >
            重新连接
          </button>
        </div>
      ) : connection === 'connecting' ? (
        <div style={mutedStyle}>正在连接烧录服务…</div>
      ) : null}

      <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
        <button
          type="button"
          disabled={!canStart}
          onClick={handleStart}
          style={{ ...controlStyle, cursor: canStart ? 'pointer' : 'default', opacity: canStart ? 1 : 0.6 }}
        >
          {inFlight ? '烧录中…' : '开始烧录'}
        </button>
        <button
          type="button"
          disabled={!canCancel}
          onClick={handleCancel}
          style={{ ...controlStyle, cursor: canCancel ? 'pointer' : 'default', opacity: canCancel ? 1 : 0.6 }}
        >
          {cancelSent ? '取消中…' : '取消'}
        </button>
        <span style={{ fontSize: '11px', opacity: 0.6, color: '#e5534b' }}>{CANCEL_HINT}</span>
        <span style={{ fontSize: '11px', opacity: 0.55 }}>由宿主通过 USB 串口烧录，浏览器不接触串口</span>
      </div>

      {progress === null ? null : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center', fontSize: '12px' }}>
            <span>
              {phase === 'running' ? '写入中' : '写入'} · {progress.percent}%
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
            opacity: status.kind === 'info' ? 0.7 : 0.95,
            color: status.kind === 'error' ? '#e5534b' : 'inherit'
          }}
        >
          <span>
            {status.kind === 'done'
              ? `烧录完成 · 固件 v${manifest === null ? '?' : manifest.version} · ${status.port} · ${formatSeconds(
                  status.seconds
                )}；请重新配网并再次同步时间。`
              : status.text}
          </span>
          {showRetry ? (
            <button type="button" onClick={handleStart} style={{ ...controlStyle, padding: '2px 8px', cursor: 'pointer' }}>
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
