/**
 * Voice source state shared between the button and the dock bar.
 * M1: fake ASR (fixed transcript). M2+: board WSS PCM / whisper worker.
 */

export type VoicePhase = 'idle' | 'listening' | 'transcribing' | 'done' | 'error'

export interface VoiceSnapshot {
  phase: VoicePhase
  detail: string
  lastTranscript: string
}

export interface VoiceState {
  get(): VoiceSnapshot
  set(next: Partial<VoiceSnapshot>): void
  subscribe(listener: () => void): () => void
}

export function createVoiceState(): VoiceState {
  let snapshot: VoiceSnapshot = { phase: 'idle', detail: '', lastTranscript: '' }
  const listeners = new Set<() => void>()
  return {
    get: () => snapshot,
    set(next) {
      snapshot = { ...snapshot, ...next }
      for (const listener of listeners) listener()
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }
  }
}
