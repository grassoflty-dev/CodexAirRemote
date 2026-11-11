/** Wire framing shared with `firmware/components/app_voice/voice.c`. */

/** Binary audio frame: 4-byte big-endian sequence number followed by PCM. */
export const AUDIO_HEADER_BYTES = 4

/** Board microphone format after the firmware downmix: 16 kHz, mono, signed 16-bit little-endian. */
export const BOARD_SAMPLE_RATE = 16_000
export const BOARD_CHANNELS = 1
export const BOARD_BYTES_PER_SAMPLE = 2
/** `voice.c` writes 640-byte (20 ms) mono frames into its 16 KiB ring. */
export const BOARD_FRAME_BYTES = 640
export const BOARD_FRAME_MS = 20

export interface AudioFrame {
  sequence: number
  pcm: Buffer
}

export function parseAudioFrame(payload: Buffer): AudioFrame | undefined {
  if (payload.length <= AUDIO_HEADER_BYTES) return undefined
  if ((payload.length - AUDIO_HEADER_BYTES) % BOARD_BYTES_PER_SAMPLE !== 0) return undefined
  return {
    sequence: payload.readUInt32BE(0),
    pcm: payload.subarray(AUDIO_HEADER_BYTES)
  }
}

export function encodeAudioFrame(sequence: number, pcm: Buffer): Buffer {
  const out = Buffer.allocUnsafe(AUDIO_HEADER_BYTES + pcm.length)
  out.writeUInt32BE(sequence >>> 0, 0)
  pcm.copy(out, AUDIO_HEADER_BYTES)
  return out
}

/** Signaling strings accepted by the firmware. */
export const AUTH = 'AUTH'
export const READY2 = 'READY2'
export const CAPTURE = 'CAPTURE'
export const GO = 'GO'
export const PULL = 'PULL'
export const WAIT = 'WAIT'
export const SEND = 'SEND'
export const CANCEL = 'CANCEL'
export const ABORT = 'ABORT'
export const ACK = 'ACK'
export const DRAFTED = 'DRAFTED'
export const CANCELLED = 'CANCELLED'

/** `AUTH ` plus the 64-character pairing token, exactly 69 bytes (checked by the firmware). */
export function authMessage(token: string): string {
  const normalized = token.trim()
  if (normalized.length !== 64) {
    throw new Error(`airremote: pairing token must be 64 characters, got ${String(normalized.length)}`)
  }
  return `${AUTH} ${normalized}`
}
