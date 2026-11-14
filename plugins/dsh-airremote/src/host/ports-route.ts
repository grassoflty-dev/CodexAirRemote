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

import type { IncomingMessage, ServerResponse } from 'node:http'
import { isSameOriginRequest } from './origin.js'
import { listBoardPorts, type BoardPortScan } from './serial-port.js'

export interface PortsRouteOptions {
  /** 测试注入：默认走真实的 `listBoardPorts()`。 */
  list?: () => Promise<BoardPortScan>
  log?: (message: string) => void
  warn?: (message: string) => void
}

export class PortsRoute {
  private readonly options: PortsRouteOptions

  constructor(options: PortsRouteOptions = {}) {
    this.options = options
  }

  readonly handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!isSameOriginRequest(req, this.options.warn)) {
      this.send(res, 403, { ok: false, code: 'forbidden', message: '跨站请求被拒绝（Origin 与 Host 不一致）', ports: [] })
      return
    }
    if ((req.method ?? 'GET').toUpperCase() !== 'GET') {
      this.send(res, 405, { ok: false, code: 'bad-request', message: '只支持 GET', ports: [] })
      return
    }
    const scan = await (this.options.list ?? listBoardPorts)()
    if (scan.ok) {
      this.options.log?.(
        `airremote: ports scan → ${String(scan.ports.length)} port(s), board=${scan.board ?? 'none'}（仅枚举，未打开串口）`
      )
    } else {
      this.options.warn?.(`airremote: ports scan failed（${scan.code ?? 'internal'}）：${scan.message ?? ''}`)
    }
    this.send(res, 200, scan)
  }

  private send(res: ServerResponse, status: number, body: unknown): void {
    if (res.headersSent || res.writableEnded) return
    const payload = `${JSON.stringify(body)}\n`
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(payload),
      'cache-control': 'no-store'
    })
    res.end(payload)
  }
}
