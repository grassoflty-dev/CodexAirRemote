/**
 * 「扫描设备」路由：`GET /airremote/ports`。
 *
 * 只枚举串口（`SerialPort.list()`，必要时退到注册表 / PnP），**不打开端口**、
 * 不占用 `SerialHolder`，因此扫描与烧录/时间同步互不干扰，也不会留下后台任务。
 *
 * 响应（HTTP 200，`Cache-Control: no-store`）：
 *   `{ ok: true,  ports: [{ path: 'COM3', vendorId: '303A', productId: '1001' }], board: 'COM3' | null }`
 *   `{ ok: false, code: 'serial-error', message: '…', ports: [] }`
 * 同源校验复用 `origin.ts`；跨站请求 403。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { type BoardPortScan } from './serial-port.js';
export interface PortsRouteOptions {
    /** 测试注入：默认走真实的 `listBoardPorts()`。 */
    list?: () => Promise<BoardPortScan>;
    log?: (message: string) => void;
    warn?: (message: string) => void;
}
export declare class PortsRoute {
    private readonly options;
    constructor(options?: PortsRouteOptions);
    readonly handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
    private send;
}
