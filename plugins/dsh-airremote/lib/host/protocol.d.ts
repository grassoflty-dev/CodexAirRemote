/** Wire framing shared with `firmware/components/app_voice/voice.c`. */
/** Binary audio frame: 4-byte big-endian sequence number followed by PCM. */
export declare const AUDIO_HEADER_BYTES = 4;
/** Board microphone format after the firmware downmix: 16 kHz, mono, signed 16-bit little-endian. */
export declare const BOARD_SAMPLE_RATE = 16000;
export declare const BOARD_CHANNELS = 1;
export declare const BOARD_BYTES_PER_SAMPLE = 2;
/** `voice.c` writes 640-byte (20 ms) mono frames into its 16 KiB ring. */
export declare const BOARD_FRAME_BYTES = 640;
export declare const BOARD_FRAME_MS = 20;
export interface AudioFrame {
    sequence: number;
    pcm: Buffer;
}
export declare function parseAudioFrame(payload: Buffer): AudioFrame | undefined;
export declare function encodeAudioFrame(sequence: number, pcm: Buffer): Buffer;
/** Signaling strings accepted by the firmware. */
export declare const AUTH = "AUTH";
export declare const READY2 = "READY2";
export declare const CAPTURE = "CAPTURE";
export declare const GO = "GO";
export declare const PULL = "PULL";
export declare const WAIT = "WAIT";
export declare const SEND = "SEND";
export declare const CANCEL = "CANCEL";
export declare const ABORT = "ABORT";
export declare const ACK = "ACK";
export declare const DRAFTED = "DRAFTED";
export declare const CANCELLED = "CANCELLED";
/** `AUTH ` plus the 64-character pairing token, exactly 69 bytes (checked by the firmware). */
export declare function authMessage(token: string): string;
