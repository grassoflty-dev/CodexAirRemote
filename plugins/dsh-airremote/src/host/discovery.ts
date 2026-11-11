/**
 * UDP discovery for the ESP32-C6 voice session (`voice.c`):
 *
 *   board -> host   `AR1A` + 6-byte MAC, sent to the gateway and broadcast on 47682
 *   host  -> board  `AR1?` + 16 bytes, answered with the same payload where byte 3 is `!`
 *
 * The board announces every 500 ms for up to 20 s after the user starts a voice
 * session, so a browser session that starts a little later can still attach.
 */

import { createSocket, type Socket } from 'node:dgram'

export interface BoardAnnouncement {
  host: string
  mac: string
  at: number
}

export interface BoardDiscoveryOptions {
  port: number
  /** Also probe with an `AR1?` broadcast while waiting (helps on networks that drop board broadcasts). */
  probe?: boolean
}

const QUERY = Buffer.from('AR1?', 'ascii')

function macText(bytes: Buffer): string {
  return [...bytes.subarray(0, 6)].map((value) => value.toString(16).padStart(2, '0')).join(':')
}

export class BoardDiscovery {
  private socket: Socket | undefined
  private probeTimer: NodeJS.Timeout | undefined
  private readonly waiters = new Set<(board: BoardAnnouncement) => void>()
  private last: BoardAnnouncement | undefined
  private closed = false
  private readonly probe: boolean

  constructor(private readonly options: BoardDiscoveryOptions) {
    this.probe = options.probe ?? true
  }

  get latest(): BoardAnnouncement | undefined {
    return this.last
  }

  async start(): Promise<void> {
    if (this.socket !== undefined) return
    const socket = createSocket({ type: 'udp4', reuseAddr: true })
    this.socket = socket
    socket.on('error', () => {
      /* A missing/occupied port must not take the plugin down; manual host still works. */
    })
    socket.on('message', (message, remote) => {
      if (message.length < 10 || message[0] !== 0x41 || message[1] !== 0x52 || message[2] !== 0x31) return
      if (message[3] !== 0x41 && message[3] !== 0x21) return
      const board: BoardAnnouncement = { host: remote.address, mac: macText(message.subarray(4, 10)), at: Date.now() }
      this.last = board
      for (const waiter of [...this.waiters]) waiter(board)
    })
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        socket.off('listening', onListening)
        reject(error)
      }
      const onListening = () => {
        socket.off('error', onError)
        resolve()
      }
      socket.once('error', onError)
      socket.once('listening', onListening)
      socket.bind(this.options.port, '0.0.0.0')
    })
    if (this.probe) {
      const query = Buffer.alloc(20)
      QUERY.copy(query, 0)
      this.probeTimer = setInterval(() => {
        if (this.closed) return
        try {
          socket.send(query, 0, query.length, this.options.port, '255.255.255.255')
        } catch {
          /* broadcast may be unavailable; announcements still arrive */
        }
      }, 1000)
      this.probeTimer.unref?.()
    }
  }

  /** Wait for the next announcement, or use one seen within `maxAgeMs`. */
  wait(timeoutMs: number, maxAgeMs = 3000): Promise<BoardAnnouncement> {
    if (this.last !== undefined && Date.now() - this.last.at <= maxAgeMs) return Promise.resolve(this.last)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(waiter)
        reject(new Error(`airremote: board did not announce on UDP ${String(this.options.port)} within ${String(timeoutMs)} ms`))
      }, timeoutMs)
      timer.unref?.()
      const waiter = (board: BoardAnnouncement) => {
        clearTimeout(timer)
        this.waiters.delete(waiter)
        resolve(board)
      }
      this.waiters.add(waiter)
    })
  }

  close(): void {
    this.closed = true
    if (this.probeTimer !== undefined) clearInterval(this.probeTimer)
    this.probeTimer = undefined
    for (const waiter of this.waiters) {
      /* Rejecting is the caller's timeout's job; drop the seats so they can time out. */
      this.waiters.delete(waiter)
    }
    const socket = this.socket
    this.socket = undefined
    if (socket !== undefined) {
      try {
        socket.close()
      } catch {
        /* already closed */
      }
    }
  }
}
