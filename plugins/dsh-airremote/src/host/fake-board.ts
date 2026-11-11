/**
 * In-process simulated board.
 *
 * It speaks the same request/response protocol as `firmware/components/app_voice/voice.c`
 * (`AUTH`/`READY2`/`CAPTURE`/`GO`/`PULL`/`ABORT`/`ACK`) over a plain WebSocket,
 * announces itself on the UDP discovery port, and loops a WAV file (or a
 * synthesized tone when no file exists). This makes the whole host -> browser
 * path testable without hardware.
 */

import { createServer, type Server } from 'node:http'
import { createSocket, type Socket as UdpSocket } from 'node:dgram'
import { existsSync, readFileSync } from 'node:fs'
import type { Duplex } from 'node:stream'
import { acceptWebSocket, type WsConnection } from './ws.js'
import {
  ABORT,
  ACK,
  CAPTURE,
  CANCELLED,
  DRAFTED,
  GO,
  PULL,
  READY2,
  SEND,
  WAIT,
  encodeAudioFrame
} from './protocol.js'

export interface FakeBoardOptions {
  host?: string
  port: number
  token: string
  wavPath: string
  discoveryPort: number
}

const FRAME_SAMPLES = 320 // 20 ms at 16 kHz
const ANNOUNCE = Buffer.from('AR1A', 'ascii')

interface Pcm {
  samples: Int16Array
  sampleRate: number
}

function parseWav(bytes: Buffer): Pcm | undefined {
  if (bytes.length < 12 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') {
    return undefined
  }
  let at = 12
  let channels = 0
  let sampleRate = 0
  let bits = 0
  let data: Buffer | undefined
  while (at + 8 <= bytes.length) {
    const id = bytes.toString('ascii', at, at + 4)
    const size = bytes.readUInt32LE(at + 4)
    const body = bytes.subarray(at + 8, Math.min(bytes.length, at + 8 + size))
    if (id === 'fmt ' && body.length >= 16) {
      const format = body.readUInt16LE(0)
      if (format !== 1) return undefined
      channels = body.readUInt16LE(2)
      sampleRate = body.readUInt32LE(4)
      bits = body.readUInt16LE(14)
    } else if (id === 'data') {
      data = body
    }
    at += 8 + size + (size & 1)
  }
  if (data === undefined || channels === 0 || sampleRate === 0 || bits !== 16) return undefined
  const source = new Int16Array(data.buffer, data.byteOffset, Math.floor(data.length / 2))
  const mono = new Int16Array(Math.floor(source.length / channels))
  for (let i = 0; i < mono.length; i++) {
    let sum = 0
    for (let c = 0; c < channels; c++) sum += source[i * channels + c]!
    mono[i] = Math.max(-32768, Math.min(32767, Math.round(sum / channels)))
  }
  if (sampleRate === 16_000) return { samples: mono, sampleRate }
  const ratio = 16_000 / sampleRate
  const out = new Int16Array(Math.max(1, Math.floor(mono.length * ratio)))
  for (let i = 0; i < out.length; i++) {
    const position = i / ratio
    const left = Math.floor(position)
    const right = Math.min(mono.length - 1, left + 1)
    const fraction = position - left
    out[i] = Math.round(mono[left]! * (1 - fraction) + mono[right]! * fraction)
  }
  return { samples: out, sampleRate: 16_000 }
}

/** A speech-like tone used when no WAV is configured: a warbling two-tone with pauses. */
function syntheticPcm(): Pcm {
  const sampleRate = 16_000
  const seconds = 4
  const samples = new Int16Array(sampleRate * seconds)
  for (let i = 0; i < samples.length; i++) {
    const t = i / sampleRate
    const cycle = t % 4
    const active = cycle < 2.4
    const frequency = cycle < 1.2 ? 220 : 330
    const envelope = active ? Math.min(1, cycle * 8, (2.4 - cycle) * 8) : 0
    samples[i] = Math.round(Math.sin(2 * Math.PI * frequency * t) * 0.25 * 32767 * envelope)
  }
  return { samples, sampleRate }
}

function loadPcm(path: string): Pcm {
  if (existsSync(path)) {
    try {
      const bytes = readFileSync(path)
      const wav = parseWav(bytes)
      if (wav !== undefined && wav.samples.length > 0) return wav
      if (bytes.length >= 2) {
        return {
          samples: new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.length / 2)),
          sampleRate: 16_000
        }
      }
    } catch {
      /* fall through to the tone */
    }
  }
  return syntheticPcm()
}

export class FakeBoard {
  private server: Server | undefined
  private udp: UdpSocket | undefined
  private announceTimer: NodeJS.Timeout | undefined
  private readonly sockets = new Set<Duplex>()
  private pcm: Pcm | undefined
  private offset = 0
  private sequence = 0
  private nextFrameAt = 0
  private readonly host: string
  private readonly options: FakeBoardOptions

  constructor(options: FakeBoardOptions) {
    this.options = options
    this.host = options.host ?? '127.0.0.1'
  }

  get address(): { host: string; port: number } {
    return { host: this.host, port: this.options.port }
  }

  async start(): Promise<void> {
    if (this.server !== undefined) return
    this.pcm = loadPcm(this.options.wavPath)
    const server = createServer((_req, res) => {
      res.writeHead(404)
      res.end()
    })
    this.server = server
    server.on('upgrade', (req, socket, head) => {
      this.sockets.add(socket)
      socket.once('close', () => this.sockets.delete(socket))
      try {
        this.accept(req, socket, head)
      } catch {
        socket.destroy()
      }
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.options.port, this.host, () => {
        server.off('error', reject)
        resolve()
      })
    })
    this.announce()
    this.announceTimer = setInterval(() => this.announce(), 500)
    this.announceTimer.unref?.()
  }

  private accept(req: Parameters<typeof acceptWebSocket>[0], socket: Duplex, head: Buffer): void {
    let authenticated = false
    let capturing = false
    let closed = false
    const connection: WsConnection = acceptWebSocket(req, socket, head, {
      onMessage: (message) => {
        if (closed) return
        if (message.type !== 'text') return
        const text = message.text
        if (!authenticated) {
          if (text === `AUTH ${this.options.token}`) {
            authenticated = true
            connection.sendText(READY2)
          } else {
            connection.close(1008, 'AUTH required')
          }
          return
        }
        if (text === CAPTURE) {
          capturing = true
          this.nextFrameAt = Date.now()
          connection.sendText(GO)
          return
        }
        if (text === PULL) {
          if (!capturing || this.pcm === undefined) {
            connection.sendText(WAIT)
            return
          }
          const now = Date.now()
          if (now + 3 < this.nextFrameAt) {
            connection.sendText(WAIT)
            return
          }
          this.nextFrameAt = Math.max(this.nextFrameAt + 20, now + 20)
          const chunk = Buffer.allocUnsafe(FRAME_SAMPLES * 2)
          for (let i = 0; i < FRAME_SAMPLES; i++) {
            chunk.writeInt16LE(this.pcm.samples[this.offset]!, i * 2)
            this.offset = (this.offset + 1) % this.pcm.samples.length
          }
          connection.sendBinary(encodeAudioFrame(this.sequence++, chunk))
          return
        }
        if (text === ABORT || text === DRAFTED || text === CANCELLED || text === SEND) {
          closed = true
          connection.sendText(ACK)
          setTimeout(() => connection.close(), 20).unref?.()
        }
      },
      onClose: () => {
        closed = true
      },
      onError: () => {
        closed = true
      }
    })
  }

  private announce(): void {
    try {
      if (this.udp === undefined) this.udp = createSocket({ type: 'udp4' })
      const packet = Buffer.concat([ANNOUNCE, Buffer.from([0x02, 0, 0, 0, 0, 0x01])])
      this.udp.send(packet, 0, packet.length, this.options.discoveryPort, '127.0.0.1')
    } catch {
      /* discovery is best effort */
    }
  }

  stop(): void {
    if (this.announceTimer !== undefined) clearInterval(this.announceTimer)
    this.announceTimer = undefined
    if (this.udp !== undefined) {
      try {
        this.udp.close()
      } catch {
        /* already closed */
      }
      this.udp = undefined
    }
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
    const server = this.server
    this.server = undefined
    if (server !== undefined) {
      try {
        server.close()
      } catch {
        /* already closed */
      }
    }
  }
}
