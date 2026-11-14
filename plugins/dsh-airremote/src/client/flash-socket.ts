/**
 * 烧录通道的 socket 抽象。
 *
 * DSH 桌面页不是普通 `http(s)` 页面：`document.baseURI` / `location.host`
 * 拿不到宿主地址，因此**优先**用 DSH 的 Connection service：
 * `ctx.connection.openWebSocket('/airremote/flash')`，它按
 * `__DSH_TRANSPORT__?.streamBaseUrl` 解析地址并复用桌面的认证 socket 工厂。
 *
 * 只有 `ctx.connection` 不可用时（测试 / 旧宿主）才走兜底：
 * 与 DSH `openConnectionWebSocket` 逐字一致的
 * `__DSH_TRANSPORT__?.streamBaseUrl ?? document.baseURI` + `http→ws`。
 */

/** 原生 WebSocket 与 DSH ConnectionWebSocket 的最小公共面。 */
export interface FlashSocket {
  readonly readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  addEventListener(type: 'open' | 'error' | 'close' | 'message', listener: (event: unknown) => void): void
  removeEventListener?(type: 'open' | 'error' | 'close' | 'message', listener: (event: unknown) => void): void
}

export const SOCKET_CONNECTING = 0
export const SOCKET_OPEN = 1

type TransportGlobal = { __DSH_TRANSPORT__?: { streamBaseUrl?: string } }

/** 与 DSH 官方实现相同的 base 解析顺序；空串表示拿不到。 */
export function transportBase(): string {
  try {
    const globals = globalThis as unknown as TransportGlobal
    const fromTransport = globals.__DSH_TRANSPORT__?.streamBaseUrl
    if (typeof fromTransport === 'string' && fromTransport.trim() !== '') return fromTransport
  } catch {
    /* ignore */
  }
  return typeof document === 'undefined' ? '' : document.baseURI
}

/** 兜底：按官方 `openConnectionWebSocket` 的算法拼 URL 并 `new WebSocket`。 */
export function openFallbackSocket(path: string): FlashSocket {
  const base = transportBase()
  if (base === '') throw new Error('no transport base（既无 __DSH_TRANSPORT__.streamBaseUrl 也无 document.baseURI）')
  const url = new URL(path.slice(1), base)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return new WebSocket(url.href) as unknown as FlashSocket
}
