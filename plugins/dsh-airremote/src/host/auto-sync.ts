/**
 * 自动对时：插件启动后、以及每次板子会话建立时，把 host 时间 + 设置里的时区写进开发板。
 *
 * 板子 RTC 断电 / 首次上电是 `2000-01-01 00:00:00`，固件判为无效、待机页显示 `--:--`；
 * 这里在**没有任何人点按钮**的情况下补一次校准，时区取自设置页保存的 `time.json`。
 *
 * 三条硬规则：
 *  - 异步、吞异常：任何失败只 `warn` 一次，不抛给 `apply()`，不阻塞插件启动；
 *  - 幂等 + 限流：同一个触发键（一次启动 / 一次连接）最多尝试一次，失败不重试；
 *  - 让路：抢不到串口锁（烧录 / 手动同步占着）或共享闸门时直接跳过，不算错误。
 */

import { minutesForTimezone, systemTimezoneName } from '../time-zones.js'
import { BoardSyncError, findBoardPort, syncBoardTime } from './serial-port.js'
import type { SerialHolder } from './serial-holder.js'
import type { SyncGate } from './sync-gate.js'
import { readTimePreference, type TimePreference } from './time-settings.js'

/** 插件加载后等多久再对时：避开 BLE / WS / UDP 初始化的资源争抢。 */
export const STARTUP_SYNC_DELAY_MS = 4000

/** 会话建立后等多久再对时：先让音频链路把 hello 发出去，再动串口。 */
export const SESSION_SYNC_DELAY_MS = 1500

/** 记住多少个触发键；连接键会一直增长，只留最近这些。 */
const MAX_REMEMBERED_KEYS = 64

/** 一次自动对时的结果。除 `synced` 外都是「跳过」，不会重试。 */
export type AutoSyncOutcome = 'synced' | 'disabled' | 'duplicate' | 'busy' | 'locked' | 'no-board' | 'failed' | 'disposed'

export interface AutoSyncResult {
  outcome: AutoSyncOutcome
  /** 实际写入的端口（找到过才有）。 */
  port?: string
  /** 写进板子的 UTC 秒。 */
  unix?: number
  /** 写进板子的分钟偏移（东为正）。 */
  minutes?: number
}

export interface AutoTimeSyncOptions {
  /** `resolveHostConfig().dataDir`，读 `time.json`。 */
  dataDir: string
  /** 配置里显式指定的串口；空串表示按 USB VID 303A 自动发现。 */
  serialPort: string
  /** 串口锁：烧录 / 手动同步占着时跳过。 */
  serialHolder?: SerialHolder
  /** 与手动同步共享的闸门。 */
  gate?: SyncGate
  /** 注入点（测试用），默认 `findBoardPort`。 */
  findPort?: (preferred: string) => Promise<string | null>
  /** 注入点（测试用），默认 `syncBoardTime`。 */
  sync?: (port: string, unixSeconds: number, minutes: number) => Promise<unknown>
  /** 时钟注入，默认 `Date.now`。 */
  now?: () => number
  /** 启动对时的延迟，默认 4 s；测试可调 0。 */
  startupDelayMs?: number
  /** 会话对时的延迟，默认 1.5 s；测试可调 0。 */
  sessionDelayMs?: number
  log?: (message: string) => void
  warn?: (message: string) => void
}

/**
 * 自动对时器。只持有「排期用的定时器集合」和「已尝试过的触发键」，
 * 不监听串口、不留常驻轮询；`dispose()` 会清掉所有还没触发的定时器。
 */
export class AutoTimeSync {
  private readonly options: AutoTimeSyncOptions
  private readonly startupDelayMs: number
  private readonly sessionDelayMs: number
  private readonly attempted = new Set<string>()
  private readonly timers = new Set<NodeJS.Timeout>()
  private disposed = false

  constructor(options: AutoTimeSyncOptions) {
    this.options = options
    this.startupDelayMs = options.startupDelayMs ?? STARTUP_SYNC_DELAY_MS
    this.sessionDelayMs = options.sessionDelayMs ?? SESSION_SYNC_DELAY_MS
  }

  /** 插件启动后排一次对时；不 await、不抛错。 */
  armStartup(): void {
    this.schedule('startup', this.startupDelayMs)
  }

  /** 一次板子会话建立（WSS 音频路由被连上）后排一次对时；`session` 只要同一连接内唯一即可。 */
  notifySession(session: string): void {
    this.schedule(`session:${session}`, this.sessionDelayMs)
  }

  /** 排期一次对时；同一个键只排一次。定时器 `unref`，不会拖住进程退出。 */
  schedule(key: string, delayMs: number): void {
    if (this.disposed || this.attempted.has(key)) return
    const timer = setTimeout(() => {
      this.timers.delete(timer)
      void this.run(key).catch(() => undefined)
    }, Math.max(0, delayMs))
    timer.unref?.()
    this.timers.add(timer)
  }

  /**
   * 真正执行一次。可以直接 `await`（测试 / 内部排期都走它）。
   * 返回值只用于日志与断言；调用方不需要区分失败原因。
   */
  async run(key: string): Promise<AutoSyncResult> {
    if (this.disposed) return { outcome: 'disposed' }
    if (this.attempted.has(key)) return { outcome: 'duplicate' }
    this.remember(key)

    let preference: TimePreference
    try {
      preference = readTimePreference(this.options.dataDir)
    } catch (error) {
      this.warn(`airremote: 自动对时读不到 time.json，跳过（${describe(error)}）`)
      return { outcome: 'failed' }
    }
    if (!preference.autoSync) return { outcome: 'disabled' }

    const gate = this.options.gate
    if (gate !== undefined && !gate.tryEnter()) {
      this.log('airremote: 自动对时跳过（已有一次同步在进行）')
      return { outcome: 'busy' }
    }

    const holder = this.options.serialHolder
    const holderState = holder?.state()
    if (holderState !== undefined && holderState.holder !== 'none') {
      gate?.leave()
      this.log(`airremote: 自动对时跳过（串口被 ${holderState.holder} 占用）`)
      return { outcome: 'locked' }
    }
    if (holder !== undefined && !holder.acquire('sync')) {
      gate?.leave()
      this.log('airremote: 自动对时跳过（串口锁抢不到）')
      return { outcome: 'locked' }
    }
    const lockHeld = holder !== undefined

    const now = this.options.now?.() ?? Date.now()
    const unix = Math.floor(now / 1000)
    const minutes = minutesForTimezone(preference.timezone, new Date(now))
    const portFinder = this.options.findPort ?? findBoardPort
    const sync = this.options.sync ?? syncBoardTime
    let port: string | null = null

    try {
      port = await portFinder(this.options.serialPort)
      if (port === null) {
        this.log(`airremote: 自动对时跳过（没找到开发板串口，时区 ${preference.timezone}）`)
        return { outcome: 'no-board', unix, minutes }
      }
      await sync(port, unix, minutes)
      this.log(
        `airremote: 自动对时完成 ${port} unix=${String(unix)} minutes=${String(minutes)} ` +
          `zone=${preference.timezone} system=${systemTimezoneName()}`
      )
      return { outcome: 'synced', port, unix, minutes }
    } catch (error) {
      this.warn(`airremote: 自动对时失败（不重试）${port ?? '?'} ${errorCode(error)}：${describe(error)}`)
      return { outcome: 'failed', port: port ?? undefined, unix, minutes }
    } finally {
      if (lockHeld) holder?.release('sync')
      gate?.leave()
    }
  }

  /** 清掉所有还没触发的定时器，并拒绝之后的排期。 */
  dispose(): void {
    this.disposed = true
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
  }

  private remember(key: string): void {
    this.attempted.add(key)
    while (this.attempted.size > MAX_REMEMBERED_KEYS) {
      const oldest = this.attempted.values().next().value
      if (oldest === undefined) return
      this.attempted.delete(oldest)
    }
  }

  private log(message: string): void {
    try {
      this.options.log?.(message)
    } catch {
      /* 日志函数坏了也不能影响对时流程 */
    }
  }

  private warn(message: string): void {
    try {
      this.options.warn?.(message)
    } catch {
      /* 同上 */
    }
  }
}

function errorCode(error: unknown): string {
  return error instanceof BoardSyncError ? error.code : 'internal'
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
