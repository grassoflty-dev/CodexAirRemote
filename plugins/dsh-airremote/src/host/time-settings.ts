/**
 * 开发板时区偏好（`<dataDir>/time.json`）。
 *
 * 这里只保存用户选的时区 id、自动对时开关和写入时间；host 不解释 IANA 时区，
 * 「跟随系统」的分钟偏移由 `time-zones.ts` 按运行环境算。
 * 文件缺失或损坏一律回落到默认值且不抛错——设置页永远能打开。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DEFAULT_TIMEZONE } from '../time-zones.js'

/** 自动对时默认开启：板子 RTC 断电后是 2000-01-01，不校准就一直显示 `--:--`。 */
export const DEFAULT_AUTO_SYNC = true

/** 与 client 约定的时区 id 形状：1..32 个 `[a-z0-9+_-]`（大小写不敏感）。 */
const TIMEZONE_PATTERN = /^[a-z0-9+_-]{1,32}$/i

export interface TimePreference {
  /** 时区 id；未保存过时为 `auto`。 */
  timezone: string
  /** 连上开发板是否自动校准时间；未保存过时为 `true`。 */
  autoSync: boolean
  /** 上次写入的 ISO 时间；未保存过时为 `null`。 */
  updatedAt: string | null
}

/** `POST /airremote/time` 允许只改其中一项，另一项沿用文件里的值。 */
export interface TimePreferencePatch {
  timezone?: string
  autoSync?: boolean
}

/** `<dataDir>/time.json` 的绝对路径。 */
export function timePreferenceFile(dataDir: string): string {
  return join(dataDir, 'time.json')
}

/** 校验一个时区 id 是否符合契约允许的形状。 */
export function isTimezoneId(value: unknown): value is string {
  return typeof value === 'string' && TIMEZONE_PATTERN.test(value.trim())
}

function parseUpdatedAt(value: unknown): string | null {
  if (typeof value !== 'string' || value === '') return null
  return Number.isNaN(Date.parse(value)) ? null : value
}

/**
 * 读取保存的偏好。文件不存在、不是 JSON、字段类型不对时都按默认值处理。
 * `autoSync` 只认布尔值，其余（含缺失）一律视为默认的「开启」。
 */
export function readTimePreference(dataDir: string): TimePreference {
  try {
    const parsed: unknown = JSON.parse(readFileSync(timePreferenceFile(dataDir), 'utf8'))
    if (parsed === null || typeof parsed !== 'object') return defaultPreference()
    const record = parsed as { timezone?: unknown; autoSync?: unknown; updatedAt?: unknown }
    return {
      timezone: isTimezoneId(record.timezone) ? record.timezone.trim().toLowerCase() : DEFAULT_TIMEZONE,
      autoSync: typeof record.autoSync === 'boolean' ? record.autoSync : DEFAULT_AUTO_SYNC,
      updatedAt: parseUpdatedAt(record.updatedAt)
    }
  } catch {
    return defaultPreference()
  }
}

/**
 * 写偏好：先读旧值把没传的字段补上，再「写 `time.json.tmp` + 同目录 rename」原子落盘，
 * 读者不会看到半个文件。返回实际落盘的内容（时区统一存小写）。
 */
export function writeTimePreference(dataDir: string, patch: TimePreferencePatch): TimePreference {
  const current = readTimePreference(dataDir)
  const value: TimePreference = {
    timezone: (patch.timezone ?? current.timezone).trim().toLowerCase(),
    autoSync: patch.autoSync ?? current.autoSync,
    updatedAt: new Date().toISOString()
  }
  const file = timePreferenceFile(dataDir)
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.tmp`
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  renameSync(temporary, file)

  return value
}

function defaultPreference(): TimePreference {
  return { timezone: DEFAULT_TIMEZONE, autoSync: DEFAULT_AUTO_SYNC, updatedAt: null }
}
