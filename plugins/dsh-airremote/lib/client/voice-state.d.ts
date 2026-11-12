/**
 * Virtual-microphone status shared between the shim and the dock bar.
 * The official DSH voice-input plugin owns the microphone button and the
 * recognition UI; this state only explains what the Air Remote link is doing.
 */
export type VoicePhase = 'idle' | 'waiting' | 'connecting' | 'live' | 'reconnecting' | 'done' | 'error';
export interface VoiceSnapshot {
    phase: VoicePhase;
    detail: string;
    lastTranscript: string;
}
export interface VoiceState {
    get(): VoiceSnapshot;
    set(next: Partial<VoiceSnapshot>): void;
    subscribe(listener: () => void): () => void;
}
export declare function createVoiceState(): VoiceState;
