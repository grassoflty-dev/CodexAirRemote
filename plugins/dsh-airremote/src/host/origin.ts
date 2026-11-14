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

import type { IncomingMessage } from 'node:http'

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

/** `127.x.x.x`、`localhost`、`[::1]` 视为本机。 */
export function isLoopbackHostname(hostname: string): boolean {
  const name = hostname.trim().toLowerCase()
  if (LOOPBACK_HOSTNAMES.has(name)) return true
  const parts = name.split('.')
  return parts.length === 4 && parts[0] === '127' && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/** 从 `Host` / `Origin` 的 host 里拆出主机名与端口（缺端口按 http 默认 80）。 */
function splitHost(host: string): { hostname: string; port: string } | undefined {
  const value = host.trim()
  if (value === '') return undefined
  try {
    const parsed = new URL(`http://${value}`)
    return { hostname: parsed.hostname, port: parsed.port === '' ? '80' : parsed.port }
  } catch {
    return undefined
  }
}

/**
 * @param warn 拒绝时记一行（带 origin / host），便于排查浏览器的 403。
 */
export function isSameOriginRequest(req: IncomingMessage, warn?: (message: string) => void): boolean {
  const origin = req.headers.origin
  const host = req.headers.host
  if (typeof origin !== 'string' || origin === '') return true
  let parsed: URL
  try {
    parsed = new URL(origin)
  } catch {
    warn?.(`airremote: rejected request with malformed Origin ${origin}`)
    return false
  }
  if (parsed.protocol === 'dsh-app:' || parsed.protocol === 'file:') return true
  if (typeof host === 'string' && parsed.host === host) return true

  const target = typeof host === 'string' ? splitHost(host) : undefined
  const originPort = parsed.port === '' ? (parsed.protocol === 'https:' ? '443' : '80') : parsed.port
  if (target !== undefined && isLoopbackHostname(parsed.hostname) && isLoopbackHostname(target.hostname) && originPort === target.port) {
    return true
  }
  warn?.(`airremote: rejected foreign Origin ${origin} (Host ${host ?? '?'})`)
  return false
}
