/**
 * 同源检查（`/airremote/*` 的 HTTP 与 WebSocket 路由共用）。
 *
 * 页面会带 `Origin`：必须与请求的 Host 一致，否则拒绝跨站请求。
 * 两种本机场景额外放行：
 *  - `dsh-app:` / `file:`：桌面壳页面；
 *  - loopback 主机名混用（`localhost` ↔ `127.0.0.1`），只要**端口一致**即可——
 *    浏览器/代理重写 Host 时两者经常不同名，但仍是同一台本机服务。
 * Node 客户端（测试）不带 Origin，直接放行。
 */
import type { IncomingMessage } from 'node:http';
/** `127.x.x.x`、`localhost`、`[::1]` 视为本机。 */
export declare function isLoopbackHostname(hostname: string): boolean;
/**
 * @param warn 拒绝时记一行（带 origin / host），便于排查浏览器的 403。
 */
export declare function isSameOriginRequest(req: IncomingMessage, warn?: (message: string) => void): boolean;
