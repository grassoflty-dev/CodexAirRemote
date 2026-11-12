/**
 * 串口互斥的「统一持有者」。
 *
 * 同一个 COM 口不能同时被浏览器 Web Serial 烧录和 host 侧的时间同步占用，
 * 但这两件事分属两个执行环境（浏览器 / Node），所以由 host 出一份共享状态：
 *
 *  - `flash`：前端点了「烧录」，在打开串口前先 POST `/airremote/serial-hold`
 *    抢锁；烧完（或用户取消）再放锁。
 *  - `sync` ：host 自己的 `POST /airremote/sync-time` 抢锁，写完时间立刻放。
 *
 * 5 分钟没有任何心跳就自动过期，避免浏览器崩掉把口永久占住。
 * 这里只记状态，不碰串口：不打开、不枚举、不留定时器（过期是在读写时惰性判断的）。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
/** 谁持有串口。`none` 表示空闲。 */
export type SerialHolderName = 'none' | 'flash' | 'sync';
/** 真正能「持有」的两方；`none` 只是一种请求值。 */
export type SerialLockName = Exclude<SerialHolderName, 'none'>;
export interface SerialHolderState {
    holder: SerialHolderName;
    /** 抢锁的 ISO 时间；空闲时为 null。 */
    since: string | null;
}
export interface SerialHolderOptions {
    /** 自动过期时间，默认 5 分钟。测试可以调小。 */
    ttlMs?: number;
    /** 时钟注入，默认 `Date.now`。 */
    now?: () => number;
}
/** 默认 5 分钟自动过期。 */
export declare const SERIAL_HOLDER_TTL_MS: number;
export declare class SerialHolder {
    private readonly ttlMs;
    private readonly now;
    private holder;
    private sinceMs;
    constructor(options?: SerialHolderOptions);
    /** 当前状态（顺便处理过期）。 */
    state(): SerialHolderState;
    /** 抢锁：空闲（或已过期）时成功；已被别人持有则失败。重复抢同一把锁算成功（幂等，`since` 不刷新）。 */
    acquire(holder: SerialLockName): boolean;
    /**
     * 放锁：只放自己持有的那把；`'none'` 表示强制清空（前端「取消烧录」兜底）。
     * 返回是否真的清空了。
     */
    release(holder: SerialHolderName): boolean;
    private expire;
}
export interface SerialRouteOptions {
    holder: SerialHolder;
    /** 正常事件（抢到 / 放掉锁）。 */
    log?: (message: string) => void;
    /** 异常事件；不抛错，只记录。 */
    warn?: (message: string) => void;
}
/**
 * 两条串口锁路由的处理体。`webServer.register` 只按路径匹配、不看方法，
 * 所以每个 handler 自己按 `req.method` 分发。
 */
export declare class SerialRoutes {
    private readonly options;
    constructor(options: SerialRouteOptions);
    /** `GET /airremote/serial-state` → `{ok:true, holder, since}`。 */
    readonly stateHandler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
    /** `POST /airremote/serial-hold` body `{"holder":"flash"|"none"}`：抢锁 / 放锁。 */
    readonly holdHandler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
}
