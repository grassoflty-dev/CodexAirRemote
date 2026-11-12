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
import type { SerialHolder } from './serial-holder.js';
import type { SyncGate } from './sync-gate.js';
/** 插件加载后等多久再对时：避开 BLE / WS / UDP 初始化的资源争抢。 */
export declare const STARTUP_SYNC_DELAY_MS = 4000;
/** 会话建立后等多久再对时：先让音频链路把 hello 发出去，再动串口。 */
export declare const SESSION_SYNC_DELAY_MS = 1500;
/** 一次自动对时的结果。除 `synced` 外都是「跳过」，不会重试。 */
export type AutoSyncOutcome = 'synced' | 'disabled' | 'duplicate' | 'busy' | 'locked' | 'no-board' | 'failed' | 'disposed';
export interface AutoSyncResult {
    outcome: AutoSyncOutcome;
    /** 实际写入的端口（找到过才有）。 */
    port?: string;
    /** 写进板子的 UTC 秒。 */
    unix?: number;
    /** 写进板子的分钟偏移（东为正）。 */
    minutes?: number;
}
export interface AutoTimeSyncOptions {
    /** `resolveHostConfig().dataDir`，读 `time.json`。 */
    dataDir: string;
    /** 配置里显式指定的串口；空串表示按 USB VID 303A 自动发现。 */
    serialPort: string;
    /** 串口锁：烧录 / 手动同步占着时跳过。 */
    serialHolder?: SerialHolder;
    /** 与手动同步共享的闸门。 */
    gate?: SyncGate;
    /** 注入点（测试用），默认 `findBoardPort`。 */
    findPort?: (preferred: string) => Promise<string | null>;
    /** 注入点（测试用），默认 `syncBoardTime`。 */
    sync?: (port: string, unixSeconds: number, minutes: number) => Promise<unknown>;
    /** 时钟注入，默认 `Date.now`。 */
    now?: () => number;
    /** 启动对时的延迟，默认 4 s；测试可调 0。 */
    startupDelayMs?: number;
    /** 会话对时的延迟，默认 1.5 s；测试可调 0。 */
    sessionDelayMs?: number;
    log?: (message: string) => void;
    warn?: (message: string) => void;
}
/**
 * 自动对时器。只持有「排期用的定时器集合」和「已尝试过的触发键」，
 * 不监听串口、不留常驻轮询；`dispose()` 会清掉所有还没触发的定时器。
 */
export declare class AutoTimeSync {
    private readonly options;
    private readonly startupDelayMs;
    private readonly sessionDelayMs;
    private readonly attempted;
    private readonly timers;
    private disposed;
    constructor(options: AutoTimeSyncOptions);
    /** 插件启动后排一次对时；不 await、不抛错。 */
    armStartup(): void;
    /** 一次板子会话建立（WSS 音频路由被连上）后排一次对时；`session` 只要同一连接内唯一即可。 */
    notifySession(session: string): void;
    /** 排期一次对时；同一个键只排一次。定时器 `unref`，不会拖住进程退出。 */
    schedule(key: string, delayMs: number): void;
    /**
     * 真正执行一次。可以直接 `await`（测试 / 内部排期都走它）。
     * 返回值只用于日志与断言；调用方不需要区分失败原因。
     */
    run(key: string): Promise<AutoSyncResult>;
    /** 清掉所有还没触发的定时器，并拒绝之后的排期。 */
    dispose(): void;
    private remember;
    private log;
    private warn;
}
