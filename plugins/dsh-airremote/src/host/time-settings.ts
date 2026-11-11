/**
 * 开发板时区偏好（`<dataDir>/time.json`）。
 *
 * 这里只保存用户选的时区 id 和写入时间；host 不解释 IANA 时区，
 * 「跟随系统」的分钟偏移由 client 算好后随同步请求传进来。
 * 文件缺失或损坏一律回落到 `auto` 且不抛错——设置页永远能打开。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 没保存过时区时的默认值，与 client 的「跟随系统」选项一致。 */
export const DEFAULT_TIMEZONE = 'auto'

/** 与 client 约定的时区 id 形状：1..32 个 `[a-z0-9+_-]`（大小写不敏感）。 */
const TIMEZONE_PATTERN = /^[a-z0-9+_-]{1,32}$/i

export interface TimePreference {
  /** 时区 id；未保存过时为 `auto`。 */
  timezone: string
  /** 上次写入的 ISO 时间；未保存过时为 `null`。 */
  updatedAt: string | null
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
 * 读取保存的时区偏好。文件不存在、不是 JSON、字段类型不对时都按 `auto` 处理。
 */
export function readTimePreference(dataDir: string): TimePreference {
  try {
    const parsed: unknown = JSON.parse(readFileSync(timePreferenceFile(dataDir), 'utf8'))
    if (parsed === null || typeof parsed !== 'object') return { timezone: DEFAULT_TIMEZONE, updatedAt: null }
    const record = parsed as { timezone?: unknown; updatedAt?: unknown }
    return {
      timezone: isTimezoneId(record.timezone) ? record.timezone.trim().toLowerCase() : DEFAULT_TIMEZONE,
      updatedAt: parseUpdatedAt(record.updatedAt)
    }
  } catch {
    return { timezone: DEFAULT_TIMEZONE, updatedAt: null }
  }
}

/**
 * 写时区偏好：先写 `time.json.tmp` 再 `rename`，同目录 rename 是原子的，
 * 读者不会看到半个文件。返回实际落盘的内容（时区统一存小写）。
 */
export function writeTimePreference(dataDir: string, timezone: string): TimePreference {
  const value: TimePreference = {
    timezone: timezone.trim().toLowerCase(),
    updatedAt: new Date().toISOString()
  }
  const file = timePreferenceFile(dataDir)
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.tmp`
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  renameSync(temporary, file)
  return value
}
