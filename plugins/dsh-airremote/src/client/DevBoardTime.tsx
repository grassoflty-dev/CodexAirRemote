import { useCallback, useEffect, useId, useState } from 'react'

/**
 * Timezone table shared with the host routes (see README.md「开发板时间」).
 * `auto` follows the browser clock; every other row pins the offset the board
 * must display. Minutes are east-positive, matching `AR1Z <minutes>`.
 */
export interface TimezoneOption {
  id: string
  label: string
  minutes?: number
}

export const TIMEZONE_OPTIONS: readonly TimezoneOption[] = [
  { id: 'auto', label: '跟随系统' },
  { id: 'utc-8', label: 'UTC−8 洛杉矶', minutes: -480 },
  { id: 'utc-5', label: 'UTC−5 纽约', minutes: -300 },
  { id: 'utc+0', label: 'UTC+0 伦敦', minutes: 0 },
  { id: 'utc+1', label: 'UTC+1 柏林', minutes: 60 },
  { id: 'utc+8', label: 'UTC+8 北京', minutes: 480 },
  { id: 'utc+9', label: 'UTC+9 东京', minutes: 540 }
]

const DEFAULT_TIMEZONE = 'auto'

/** Resolve a stored id to the offset the board expects (east positive). */
export function minutesForTimezone(id: string): number {
  const option = TIMEZONE_OPTIONS.find((candidate) => candidate.id === id)
  if (option?.minutes !== undefined) return option.minutes
  return -new Date().getTimezoneOffset()
}

/** Human reason for a failed sync; unknown codes fall back to the host message. */
export function syncFailureText(error: string | undefined, message: string | undefined): string {
  switch (error) {
    case 'no-board':
      return '未找到开发板（USB VID 303A）'
    case 'open-failed':
      return '串口打不开（可能被占用）'
    case 'timeout':
      return '板子没有响应'
    case 'rejected':
      return '板子拒绝了命令'
    case 'busy':
      return '上一次同步还没结束'
    default:
      return message ?? '同步失败'
  }
}

interface TimePreferenceResponse {
  ok?: boolean
  timezone?: string
  updatedAt?: string | null
  message?: string
}

interface SyncTimeResponse {
  ok?: boolean
  port?: string | null
  unix?: number
  minutes?: number
  error?: string
  message?: string
}

interface StatusLine {
  tone: 'info' | 'ok' | 'error'
  text: string
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<{ status: number; data: T }> {
  const response = await fetch(path, init)
  const data = (await response.json().catch(() => ({}))) as T
  return { status: response.status, data }
}

function formatLocalTime(unix: number): string {
  const date = new Date(unix * 1000)
  const pad = (value: number) => String(value).padStart(2, '0')
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  )
}

/**
 * Settings section: the board keeps UTC in its RTC, the display offset lives in
 * NVS. Picking a zone only persists the choice; a serial round-trip happens on
 * the explicit button press — never on mount, never on a poll.
 */
export function DevBoardTime() {
  const selectId = useId()
  const [timezone, setTimezone] = useState(DEFAULT_TIMEZONE)
  const [status, setStatus] = useState<StatusLine | null>(null)
  const [saving, setSaving] = useState(false)
  const [syncing, setSyncing] = useState(false)

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const { status: httpStatus, data } = await requestJson<TimePreferenceResponse>('/airremote/time')
        if (!alive) return
        const known = TIMEZONE_OPTIONS.some((option) => option.id === data.timezone)
        if (httpStatus === 200 && data.ok !== false && known) {
          setTimezone(data.timezone as string)
        } else {
          setTimezone(DEFAULT_TIMEZONE)
          setStatus({ tone: 'info', text: '读取已保存的时区失败，已回退到「跟随系统」' })
        }
      } catch {
        if (!alive) return
        setTimezone(DEFAULT_TIMEZONE)
        setStatus({ tone: 'info', text: '读取已保存的时区失败，已回退到「跟随系统」' })
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  const handleTimezoneChange = useCallback((next: string) => {
    setTimezone(next)
    setSaving(true)
    setStatus(null)
    void (async () => {
      try {
        const { status: httpStatus, data } = await requestJson<TimePreferenceResponse>('/airremote/time', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ timezone: next })
        })
        if (httpStatus === 200 && data.ok !== false) {
          setStatus({ tone: 'ok', text: '已保存' })
        } else {
          setStatus({ tone: 'error', text: data.message ?? '保存失败' })
        }
      } catch {
        setStatus({ tone: 'error', text: '保存失败（无法连接本地服务）' })
      } finally {
        setSaving(false)
      }
    })()
  }, [])

  const handleSync = useCallback(() => {
    if (syncing) return
    setSyncing(true)
    setStatus(null)
    void (async () => {
      const minutes = minutesForTimezone(timezone)
      try {
        const { status: httpStatus, data } = await requestJson<SyncTimeResponse>('/airremote/sync-time', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ minutes })
        })
        if (httpStatus === 200 && data.ok === true) {
          const port = typeof data.port === 'string' && data.port !== '' ? data.port : '串口'
          const when = typeof data.unix === 'number' ? ` · ${formatLocalTime(data.unix)}` : ''
          setStatus({ tone: 'ok', text: `已同步 · ${port}${when}` })
        } else {
          setStatus({ tone: 'error', text: syncFailureText(data.error, data.message) })
        }
      } catch {
        setStatus({ tone: 'error', text: '同步失败（无法连接本地服务）' })
      } finally {
        setSyncing(false)
      }
    })()
  }, [syncing, timezone])

  const controlStyle = {
    fontSize: '12px',
    padding: '4px 10px',
    borderRadius: '6px',
    border: '1px solid rgba(127, 127, 127, 0.4)',
    background: 'rgba(127, 127, 127, 0.12)',
    color: 'inherit'
  } as const

  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: '8px', padding: '4px 2px' }}>
      <div style={{ fontSize: '13px', fontWeight: 600 }}>开发板时间</div>
      <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
        <label htmlFor={selectId} style={{ fontSize: '12px', opacity: 0.75 }}>
          时区
        </label>
        <select
          id={selectId}
          value={timezone}
          disabled={saving || syncing}
          onChange={(event) => handleTimezoneChange(event.target.value)}
          style={controlStyle}
        >
          {TIMEZONE_OPTIONS.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={syncing}
          onClick={handleSync}
          style={{ ...controlStyle, cursor: syncing ? 'default' : 'pointer', opacity: syncing ? 0.6 : 1 }}
        >
          {syncing ? '同步中…' : '同步到开发板'}
        </button>
      </div>
      {status === null ? null : (
        <div
          role="status"
          aria-live="polite"
          style={{
            fontSize: '12px',
            opacity: status.tone === 'info' ? 0.6 : 0.9,
            color: status.tone === 'error' ? '#e5534b' : 'inherit'
          }}
        >
          {status.text}
        </div>
      )}
    </section>
  )
}
