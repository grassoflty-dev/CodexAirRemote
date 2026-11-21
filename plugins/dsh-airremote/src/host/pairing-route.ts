import type { IncomingMessage, ServerResponse } from 'node:http'
import { writeBoardPairing } from './board-pairing.js'
import { isLoopbackHostname, isSameOriginRequest } from './origin.js'
import { pairBoardUsb } from './serial-port.js'
import type { SerialHolder } from './serial-holder.js'

/** USB identity operations are local-only and never return credentials to the browser. */
export function pairingHandler(dataDir: string, holder: SerialHolder, rotate = false) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const reply = (status: number, body: object) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify(body))
    }
    if (req.method !== 'POST') return reply(405, { ok: false, code: 'method' })
    let host = ''
    try { host = new URL(`http://${req.headers.host ?? ''}`).hostname } catch { /* reject below */ }
    const remote = (req.socket.remoteAddress ?? '').replace(/^::ffff:/i, '')
    if (!isLoopbackHostname(host) || !isLoopbackHostname(remote) || !isSameOriginRequest(req) ||
        req.headers['x-airremote-pairing'] !== '1') return reply(403, { ok: false, code: 'local-only' })
    if (holder.state().holder !== 'none' || !holder.acquire('sync')) return reply(409, { ok: false, code: 'busy' })
    try {
      const pairing = await pairBoardUsb(rotate)
      if (rotate) return reply(200, { ok: true, restart: true })
      if (!pairing) throw new Error('No device pairing identity')
      writeBoardPairing(dataDir, pairing)
      return reply(200, { ok: true, fingerprint: pairing.fingerprint })
    } catch {
      // Serial/crypto failures can contain raw input. Never log or return it.
      return reply(400, { ok: false, code: 'pairing-failed' })
    } finally {
      holder.release('sync')
    }
  }
}
