/**
 * 时区表（设置页下拉项与 host 自动对时共用）。
 *
 * 单位是「分钟、东为正」，与固件 `AR1Z <minutes>` 一致（480 = UTC+8）。
 * 本模块必须保持无副作用、不 import node 内置模块：浏览器 bundle 和 host 都会引它。
 * `auto` 表示跟随当前运行环境的系统时钟；未知 id 也按系统时钟处理，与设置页回退一致。
 */

/** 时区选项；`minutes` 缺省表示跟随系统。 */
export interface TimezoneOption {
  id: string
  label: string
  minutes?: number
}

/** 没保存过时区、或保存值不认识时的默认项。 */
export const DEFAULT_TIMEZONE = 'auto'

/** 固件接受的分钟范围（东为正，UTC−12:00..UTC+14:00）。 */
export const MIN_TIMEZONE_MINUTES = -720
export const MAX_TIMEZONE_MINUTES = 840

/** 设置页展示的顺序，固定项之外不要随便增删（已存进 `time.json` 的 id 要能继续识别）。 */
export const TIMEZONE_OPTIONS: readonly TimezoneOption[] = [
  { id: 'auto', label: '跟随系统' },
  { id: 'utc-8', label: 'UTC−8 洛杉矶', minutes: -480 },
  { id: 'utc-5', label: 'UTC−5 纽约', minutes: -300 },
  { id: 'utc+0', label: 'UTC+0 伦敦', minutes: 0 },
  { id: 'utc+1', label: 'UTC+1 柏林', minutes: 60 },
  { id: 'utc+8', label: 'UTC+8 北京', minutes: 480 },
  { id: 'utc+9', label: 'UTC+9 东京', minutes: 540 }
]

/** 当前环境的时区偏移（分钟、东为正），夹到固件接受的范围内。 */
export function systemOffsetMinutes(now: Date = new Date()): number {
  const minutes = -now.getTimezoneOffset()
  if (minutes < MIN_TIMEZONE_MINUTES) return MIN_TIMEZONE_MINUTES
  if (minutes > MAX_TIMEZONE_MINUTES) return MAX_TIMEZONE_MINUTES
  return minutes
}

/** 当前环境的 IANA 时区名，只用于日志；取不到时回 `system`。 */
export function systemTimezoneName(): string {
  try {
    const name = Intl.DateTimeFormat().resolvedOptions().timeZone
    return typeof name === 'string' && name !== '' ? name : 'system'
  } catch {
    return 'system'
  }
}

/**
 * 把设置里的时区 id 换成 `AR1Z` 需要的分钟偏移。
 * 固定项直接用表里的值；`auto`、未知 id 都跟随系统时钟（与设置页的回退行为一致）。
 */
export function minutesForTimezone(id: string, now: Date = new Date()): number {
  const option = TIMEZONE_OPTIONS.find((candidate) => candidate.id === id)
  if (option?.minutes !== undefined) return option.minutes
  return systemOffsetMinutes(now)
}
