/**
 * 「开发板时间」的 HTTP 路由（contract: `/airremote/time`、`/airremote/sync-time`）。
 *
 * - `GET  /airremote/time`  读保存的时区选择与自动对时开关
 * - `POST /airremote/time`  存时区选择 / 自动对时开关（可只传其中一项）
 * - `POST /airremote/sync-time` 用串口把 host 当前时间 + 分钟偏移写给板子
 *
 * 这几条路由只在有人点击时动作：没有定时器、没有轮询、没有插拔监听。
 * 自动对时是另一边 `AutoTimeSync` 的事，两边通过共享的 `SyncGate` 保证同一时刻只同步一次。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SerialHolder } from './serial-holder.js';
import type { SyncGate } from './sync-gate.js';
export interface TimeRouteOptions {
    /** `resolveHostConfig().dataDir`，`time.json` 放这里。 */
    dataDir: string;
    /** 配置里显式指定的串口；空串表示自动发现。 */
    serialPort: string;
    /** 串口锁：浏览器烧录时占着 `flash`，这里同步前必须抢到 `sync`。 */
    serialHolder?: SerialHolder;
    /** 与自动对时共享的「一次只同步一次」闸门；不传则只靠自身的 `syncing` 标记。 */
    gate?: SyncGate;
    /** 正常事件（如一次成功的同步）。 */
    log?: (message: string) => void;
    /** 异常事件；不抛错，只记录。 */
    warn?: (message: string) => void;
}
/**
 * 三条路由的处理体。`webServer.register` 只按路径匹配、不区分方法，
 * 所以 `/airremote/time` 用同一个 handler 内部按 `req.method` 分发
 * （不能对同一路径注册两次：webserver 对重复 (kind, path) 会直接抛错）。
 */
export declare class TimeRoutes {
    private readonly options;
    /** 同步进行中；第二次请求立即回 `busy`，不排队。 */
    private syncing;
    private disposed;
    constructor(options: TimeRouteOptions);
    /** `/airremote/time`。 */
    readonly timeHandler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
    /** `/airremote/sync-time`。 */
    readonly syncTimeHandler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
    dispose(): void;
    /**
     * 与 `audio-route.ts` 相同的同源策略：页面请求会带 Origin，必须和 Host 一致；
     * `dsh-app:` / `file:` 是桌面壳，Node 客户端（测试）不带 Origin，都放行。
     */
    private originAllowed;
    private rejectForeignOrigin;
    private sendPreference;
    /**
     * `POST /airremote/time`：`{timezone?}` 与 `{autoSync?}` 至少给一个，
     * 只改给出的字段，另一个沿用文件里的值。
     */
    private savePreference;
    private sync;
    private badRequest;
    private sendJson;
}
