/**
 * `/airremote/flash` upgrade route：浏览器点「烧录」→ host 用 esptool-js 烧内置固件。
 *
 * 协议（客户端按这个写，改之前先对齐）：
 *
 *   连接建立（可以同时有多条）→
 *     服务端立刻发 `{"type":"state","phase":"idle"|"running"}`
 *     （`running` = 已有烧录任务在跑，这条连接只是观察者）
 *
 *   客户端 → 服务端：`{"type":"start"}`、`{"type":"cancel"}`（也接受 `{"type":"ping"}`）
 *
 *   服务端 → 所有连接（广播）：
 *     `{"type":"state","phase":"running"|"done"|"error"|"cancelled"}`
 *     `{"type":"log","line":"<esptool 原始行>"}`
 *     `{"type":"progress","percent":0-100,"written":N,"total":N}`
 *     `{"type":"done","port":"COM7","seconds":12.3}`
 *     `{"type":"error","code":"<错误码>","message":"<中文>"}`
 *     `{"type":"ping","at":<epoch ms>}`（每 15s，仅保活）
 *
 * 多连接语义（为什么不再「单会话 + busy 断开」）：
 *  - 设置页一挂载就连 WS 并一直留着，如果把「已有连接」当忙碌，任何外部/脚本连接
 *    都会恒回 busy，且服务端 45s 空闲 close(1001,'idle') 会让页面显示「已断开」。
 *  - 因此允许多条连接并存，每条都能连/断、都能观察状态、都能发 `cancel`。
 *  - 只有**烧录任务**独占：已有任务在跑时再收到 `start`，只回
 *    `{"type":"error","code":"busy","message":"已有一次烧录在进行，请等它结束"}`，**不关闭连接**。
 *  - `log`/`progress`/`state`/`done`/`error` 广播给所有连接，中途连上来的也能看进度。
 *  - 心跳每 15s 发一条 `ping` 只为保持链路活跃，**不因客户端空闲而断开**；
 *    连接自己断了由 socket 的 close 事件自然移除。
 *
 * 与 `audio-route.ts` 一致：同源检查（`originAllowed`）。
 * **任务结束 / 取消 / 失败后串口与 `SerialHolder` 的释放顺序仍由 `flash-service.ts`
 * 的 finally 保证**，这里只在任务收尾时把任务槽清空并放锁。
 */
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { flashFirmware } from './flash-service.js';
import type { SerialHolder } from './serial-holder.js';
export interface FlashRouteOptions {
    /** 插件包根下的 `firmware/` 目录（绝对路径）。 */
    firmwareDir: string;
    /** 串口互斥：烧录期间持有 `flash`，`/airremote/sync-time` 会回 busy。 */
    holder?: SerialHolder;
    /** 目标串口解析（配置优先、其次自动发现）；默认 `findBoardPort('')`。返回 null = 没找到板子。 */
    resolvePort?: () => Promise<string | null>;
    logger?: (message: string) => void;
    warn?: (message: string) => void;
    /** 测试注入：默认用 `flashFirmware`。 */
    flash?: typeof flashFirmware;
}
export declare class FlashRoute {
    /** 所有活着的连接；连/断都只动这个集合。 */
    private readonly clients;
    /** 当前烧录任务；`undefined` = 空闲。只有它会产生「忙碌」。 */
    private task;
    private heartbeat;
    private disposed;
    private readonly options;
    constructor(options: FlashRouteOptions);
    /** `webServer.registerUpgrade` handler。 */
    readonly handler: (req: IncomingMessage, socket: Duplex, head: Buffer) => void;
    /** 只在有连接时开一个 interval；只发 ping，不因空闲关闭。 */
    private ensureHeartbeat;
    private stopHeartbeat;
    private heartbeatTick;
    /** 发起一次烧录；已有任务时只回 busy 错误，连接保持。 */
    private start;
    /** 任意连接都可以取消；没有任务时只把「空闲」回给发起者。 */
    private cancel;
    /**
     * 烧录目标口：用注入的解析器（index.ts 传配置里的 `serialPort`，为空则自动发现），
     * 默认走 `findBoardPort('')`——与时间同步同一条发现路径。
     */
    private resolvePort;
    /** 广播给所有连接；顺手清掉已经关掉的。 */
    private broadcast;
    private sendJson;
    dispose(): void;
}
