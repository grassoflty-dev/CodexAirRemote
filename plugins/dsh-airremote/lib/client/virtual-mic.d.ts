/**
 * Virtual microphone shim for the official DSH voice-input plugin.
 *
 * The official plugin calls `navigator.mediaDevices.enumerateDevices()` to list
 * inputs and `getUserMedia({audio:{deviceId:{exact: id}}})` to acquire one. This
 * module appends a synthetic `airremote` input and, only for that id, returns a
 * `MediaStreamAudioDestinationNode` stream fed by the board PCM arriving over
 * `/airremote/audio`. Every other acquisition passes through untouched.
 *
 * Board audio is 16 kHz mono s16le; Web Audio resamples it to the output
 * context rate and schedules 20 ms buffers on a small jitter cushion. The
 * official MediaRecorder then records the destination stream exactly like a
 * physical microphone, so recognition, the draft write and the settings page
 * stay entirely owned by the official plugin.
 */
import type { VoiceState } from './voice-state.js';
export declare const VIRTUAL_DEVICE_ID = "airremote";
export declare const VIRTUAL_DEVICE_LABEL = "Air Remote (ESP32-C6)";
export declare const AUDIO_ROUTE = "/airremote/audio";
export declare const VOICE_PREFERENCE_KEY = "dsh.voice-input.microphone";
export interface VirtualMicOptions {
    status?: VoiceState;
    /** Override for tests; defaults to the origin of the page. */
    audioUrl?: string;
}
/**
 * Install the device-list and acquisition patches. Returns an idempotent
 * disposer that restores every prototype method and releases live sessions.
 */
export declare function installVirtualMicrophone(options?: VirtualMicOptions): () => void;
/** Test/telemetry helper: number of live synthetic streams. */
export declare function virtualMicSessionCount(): number;
