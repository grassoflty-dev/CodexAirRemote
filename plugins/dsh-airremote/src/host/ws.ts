/**
 * Minimal RFC 6455 WebSocket implementation for the two links this plugin owns:
 *
 *  - browser  -> host: the `dsh-host-webserver` upgrade route (`/airremote/audio`)
 *  - host     -> board: the TLS WebSocket client the ESP32-C6 `voice.c` serves on 47683
 *
 * The plugin deliberately carries no runtime dependency beyond Node builtins, so
 * this file implements the small subset both peers need: the opening handshake,
 * masked client frames, unmasked server frames, text/binary/close/ping/pong, and
 * continuation frames. No extensions (permessage-deflate) are negotiated.
 */

import { createHash, randomBytes } from 'node:crypto'
import { connect as netConnect, type Socket } from 'node:net'
import { connect as tlsConnect, type TLSSocket } from 'node:tls'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

export type WsMessage =
  | { type: 'text'; text: string }
  | { type: 'binary'; data: Buffer }

export interface WsHandlers {
  onMessage?: (message: WsMessage) => void
  onClose?: (code: number, reason: string) => void
  onError?: (error: Error) => void
}

export interface WsConnection {
  readonly open: boolean
  sendText(text: string): boolean
  sendBinary(data: Buffer | Uint8Array): boolean
  close(code?: number, reason?: string): void
  terminate(): void
}

const EMPTY = Buffer.alloc(0)

function frameHeader(opcode: number, length: number, masked: boolean): Buffer {
  let header: Buffer
  if (length < 126) {
    header = Buffer.alloc(2)
    header[1] = length
  } else if (length <= 0xffff) {
    header = Buffer.alloc(4)
    header[1] = 126
    header.writeUInt16BE(length, 2)
  } else {
    header = Buffer.alloc(10)
    header[1] = 127
    header.writeBigUInt64BE(BigInt(length), 2)
  }
  header[0] = 0x80 | (opcode & 0x0f)
  header[1] |= masked ? 0x80 : 0
  return header
}

/** Encode one complete (unfragmented) frame. */
export function encodeFrame(opcode: number, payload: Buffer, masked: boolean): Buffer {
  const header = frameHeader(opcode, payload.length, masked)
  if (!masked) return Buffer.concat([header, payload])
  const key = randomBytes(4)
  const body = Buffer.allocUnsafe(payload.length)
  for (let i = 0; i < payload.length; i++) body[i] = payload[i]! ^ key[i & 3]!
  return Buffer.concat([header, key, body])
}

const OP_CONTINUATION = 0x0
const OP_TEXT = 0x1
const OP_BINARY = 0x2
const OP_CLOSE = 0x8
const OP_PING = 0x9
const OP_PONG = 0xa

/** Incremental frame parser shared by both ends. */
class FrameReader {
  private buffer: Buffer = EMPTY
  private fragments: Buffer[] = []
  private fragmentOpcode = 0
  private closed = false

  constructor(
    private readonly masked: boolean,
    private readonly handlers: WsHandlers,
    private readonly sendControl: (opcode: number, payload: Buffer) => void,
    private readonly notifyClose: (code: number, reason: string) => void
  ) {}

  push(chunk: Buffer): void {
    if (chunk.length === 0 || this.closed) return
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
    for (;;) {
      const parsed = this.parseOne()
      if (parsed === undefined) return
      if (parsed === null) {
        this.closed = true
        return
      }
    }
  }

  /** @returns true when a frame was consumed, undefined when more bytes are needed, null when closed. */
  private parseOne(): boolean | undefined | null {
    const b = this.buffer
    if (b.length < 2) return undefined
    const fin = (b[0]! & 0x80) !== 0
    const rsv = b[0]! & 0x70
    const opcode = b[0]! & 0x0f
    const hasMask = (b[1]! & 0x80) !== 0
    let length = b[1]! & 0x7f
    let offset = 2
    if (rsv !== 0) {
      this.fail(1002, 'reserved bits set')
      return null
    }
    if (hasMask !== this.masked) {
      this.fail(1002, this.masked ? 'client frame is not masked' : 'server frame is masked')
      return null
    }
    if (length === 126) {
      if (b.length < 4) return undefined
      length = b.readUInt16BE(2)
      offset = 4
    } else if (length === 127) {
      if (b.length < 10) return undefined
      const big = b.readBigUInt64BE(2)
      if (big > BigInt(16 * 1024 * 1024)) {
        this.fail(1009, 'frame too large')
        return null
      }
      length = Number(big)
      offset = 10
    }
    if (length > 8 * 1024 * 1024) {
      this.fail(1009, 'frame too large')
      return null
    }
    let maskKey: Buffer | undefined
    if (hasMask) {
      if (b.length < offset + 4) return undefined
      maskKey = b.subarray(offset, offset + 4)
      offset += 4
    }
    if (b.length < offset + length) return undefined
    let payload = b.subarray(offset, offset + length)
    if (maskKey !== undefined) {
      const unmasked = Buffer.allocUnsafe(length)
      for (let i = 0; i < length; i++) unmasked[i] = payload[i]! ^ maskKey[i & 3]!
      payload = unmasked
    }
    this.buffer = b.subarray(offset + length)

    if (opcode >= 0x8) {
      if (!fin || length > 125) {
        this.fail(1002, 'invalid control frame')
        return null
      }
      if (opcode === OP_CLOSE) {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005
        const reason = payload.length > 2 ? payload.subarray(2).toString('utf8') : ''
        this.closed = true
        try {
          this.sendControl(OP_CLOSE, payload.length >= 2 ? payload.subarray(0, 2) : EMPTY)
        } catch {
          /* the peer may already be gone */
        }
        this.notifyClose(code, reason)
        return null
      }
      if (opcode === OP_PING) {
        this.sendControl(OP_PONG, payload)
        return true
      }
      if (opcode === OP_PONG) return true
      this.fail(1002, `unknown control opcode ${String(opcode)}`)
      return null
    }

    if (opcode === OP_CONTINUATION) {
      if (this.fragmentOpcode === 0) {
        this.fail(1002, 'continuation without a message')
        return null
      }
      this.fragments.push(payload)
      if (fin) {
        const complete = Buffer.concat(this.fragments)
        const kind = this.fragmentOpcode
        this.fragments = []
        this.fragmentOpcode = 0
        this.dispatch(kind, complete)
      }
      return true
    }
    if (this.fragmentOpcode !== 0) {
      this.fail(1002, 'new message before the previous one ended')
      return null
    }
    if (fin) {
      this.dispatch(opcode, payload)
    } else {
      this.fragmentOpcode = opcode
      this.fragments = [payload]
    }
    return true
  }

  private dispatch(opcode: number, payload: Buffer): void {
    if (opcode === OP_TEXT) this.handlers.onMessage?.({ type: 'text', text: payload.toString('utf8') })
    else if (opcode === OP_BINARY) this.handlers.onMessage?.({ type: 'binary', data: payload })
    else this.fail(1002, `unknown data opcode ${String(opcode)}`)
  }

  private fail(code: number, reason: string): void {
    this.closed = true
    try {
      this.sendControl(OP_CLOSE, closePayload(code, reason))
    } catch {
      /* ignore */
    }
    this.notifyClose(code, reason)
  }
}

function closePayload(code: number, reason: string): Buffer {
  const text = Buffer.from(reason, 'utf8').subarray(0, 123)
  const payload = Buffer.allocUnsafe(2 + text.length)
  payload.writeUInt16BE(code, 0)
  text.copy(payload, 2)
  return payload
}

/** Shared connection wrapper around a duplex socket. */
class Connection implements WsConnection {
  open = true
  private reader: FrameReader
  private closeSent = false

  constructor(
    private readonly socket: Duplex,
    private readonly incomingMasked: boolean,
    private readonly outgoingMasked: boolean,
    private readonly handlers: WsHandlers,
    head?: Buffer
  ) {
    this.reader = new FrameReader(incomingMasked, handlers, (opcode, payload) => {
      this.write(encodeFrame(opcode, payload, outgoingMasked))
    }, (code, reason) => {
      if (this.open) {
        this.open = false
        handlers.onClose?.(code, reason)
      }
    })
    socket.on('data', (chunk: Buffer) => {
      this.reader.push(chunk)
    })
    socket.on('error', (error: Error) => {
      this.open = false
      handlers.onError?.(error)
    })
    socket.on('close', () => {
      if (this.open) {
        this.open = false
        handlers.onClose?.(1006, 'socket closed')
      }
    })
    if (head !== undefined && head.length > 0) this.reader.push(head)
  }

  private write(data: Buffer): boolean {
    if (!this.open || this.socket.destroyed) return false
    try {
      return this.socket.write(data)
    } catch (error) {
      this.open = false
      this.handlers.onError?.(error instanceof Error ? error : new Error(String(error)))
      return false
    }
  }

  sendText(text: string): boolean {
    return this.write(encodeFrame(OP_TEXT, Buffer.from(text, 'utf8'), this.outgoingMasked))
  }

  sendBinary(data: Buffer | Uint8Array): boolean {
    return this.write(encodeFrame(OP_BINARY, Buffer.from(data), this.outgoingMasked))
  }

  close(code = 1000, reason = ''): void {
    if (!this.open || this.closeSent) return
    this.closeSent = true
    this.write(encodeFrame(OP_CLOSE, closePayload(code, reason), this.outgoingMasked))
    this.open = false
    this.socket.end()
    setTimeout(() => this.socket.destroy(), 500).unref?.()
  }

  terminate(): void {
    this.open = false
    this.socket.destroy()
  }
}

/** Complete the server-side opening handshake for one `upgrade` event. */
export function acceptWebSocket(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  handlers: WsHandlers
): WsConnection {
  const key = req.headers['sec-websocket-key']
  const upgrade = req.headers.upgrade
  if (typeof key !== 'string' || key.length === 0 || typeof upgrade !== 'string' || upgrade.toLowerCase() !== 'websocket') {
    socket.destroy()
    throw new Error('websocket: not an RFC 6455 upgrade request')
  }
  if (req.headers['sec-websocket-version'] !== '13') {
    socket.write('HTTP/1.1 426 Upgrade Required\r\nSec-WebSocket-Version: 13\r\nConnection: close\r\n\r\n')
    socket.destroy()
    throw new Error('websocket: unsupported version')
  }
  const accept = createHash('sha1').update(key + GUID).digest('base64')
  socket.write(
    [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '',
      ''
    ].join('\r\n')
  )
  return new Connection(socket, true, false, handlers, head)
}

export interface BoardTlsOptions {
  /** Trust this PEM chain instead of Node's public roots. */
  ca?: string | Buffer
  /** Hostname to validate; the board certificate is issued for `airremote.local`. */
  servername?: string
  /** Accept the board's self-signed certificate without a CA (development only). */
  rejectUnauthorized?: boolean
}

export interface ConnectWebSocketOptions {
  host: string
  port: number
  path: string
  timeoutMs?: number
  tls?: BoardTlsOptions
}

/**
 * Open a WebSocket client. The socket is returned after the 101 response, so
 * callers can send AUTH immediately; connection failures reject.
 */
export function connectWebSocket(options: ConnectWebSocketOptions, handlers: WsHandlers): Promise<WsConnection> {
  const timeoutMs = options.timeoutMs ?? 10_000
  return new Promise((resolve, reject) => {
    let socket: Socket | TLSSocket
    let settled = false
    let buffer: Buffer = EMPTY

    const fail = (error: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        socket.destroy()
      } catch {
        /* ignore */
      }
      reject(error)
    }

    const timer = setTimeout(() => fail(new Error(`websocket: connect timed out after ${String(timeoutMs)} ms`)), timeoutMs)
    timer.unref?.()

    if (options.tls === undefined) {
      socket = netConnect({ host: options.host, port: options.port })
      socket.once('connect', sendUpgrade)
    } else {
      socket = tlsConnect({
        host: options.host,
        port: options.port,
        servername: options.tls.servername,
        ca: options.tls.ca,
        rejectUnauthorized: options.tls.rejectUnauthorized ?? false
      })
      socket.once('secureConnect', sendUpgrade)
    }
    socket.on('error', (error: Error) => fail(error))
    socket.on('close', () => {
      if (!settled) fail(new Error('websocket: socket closed before the handshake completed'))
    })

    function sendUpgrade() {
      const key = randomBytes(16).toString('base64')
      const hostHeader = options.host.includes(':') ? `[${options.host}]:${String(options.port)}` : `${options.host}:${String(options.port)}`
      const request = [
        `GET ${options.path} HTTP/1.1`,
        `Host: ${hostHeader}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
        '',
        ''
      ].join('\r\n')
      socket.write(request)
      socket.on('data', (chunk: Buffer) => {
        if (settled) {
          /* After the handshake the Connection owns this socket. */
          return
        }
        buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk])
        const end = buffer.indexOf('\r\n\r\n')
        if (end === -1) {
          if (buffer.length > 16 * 1024) fail(new Error('websocket: handshake response too large'))
          return
        }
        const head = buffer.subarray(0, end).toString('latin1')
        const rest = buffer.subarray(end + 4)
        const lines = head.split('\r\n')
        const status = /^HTTP\/1\.[01] (\d{3})/.exec(lines[0] ?? '')
        if (status?.[1] !== '101') {
          fail(new Error(`websocket: upgrade rejected (${lines[0] ?? 'no status line'})`))
          return
        }
        const expected = createHash('sha1').update(key + GUID).digest('base64')
        const acceptLine = lines.find((line) => line.toLowerCase().startsWith('sec-websocket-accept:'))
        if (acceptLine === undefined || acceptLine.slice(acceptLine.indexOf(':') + 1).trim() !== expected) {
          fail(new Error('websocket: bad Sec-WebSocket-Accept'))
          return
        }
        settled = true
        clearTimeout(timer)
        const connection = new Connection(socket, false, true, handlers, rest)
        resolve(connection)
      })
    }
  })
}
