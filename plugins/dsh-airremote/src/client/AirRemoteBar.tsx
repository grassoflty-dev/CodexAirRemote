import { useEffect, useState } from 'react'
import type { VoiceState } from './voice-state.js'

export interface AirRemoteBarProps {
  voiceState?: VoiceState
}

/** Dock hint under the composer: explains the Air Remote link while the official mic is active. */
export function AirRemoteBar({ voiceState }: AirRemoteBarProps) {
  const [snapshot, setSnapshot] = useState(() =>
    voiceState?.get() ?? { phase: 'idle' as const, detail: '', lastTranscript: '' }
  )

  useEffect(() => {
    if (voiceState === undefined) return
    const unsubscribe = voiceState.subscribe(() => setSnapshot(voiceState.get()))
    return unsubscribe
  }, [voiceState])

  if (snapshot.phase === 'idle') return null

  const icon = snapshot.phase === 'error' ? '⚠️' : snapshot.phase === 'live' ? '🔴' : '🎙'
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        display: 'flex',
        gap: '8px',
        alignItems: 'center',
        fontSize: '12px',
        opacity: 0.85,
        padding: '2px 4px'
      }}
    >
      <span aria-hidden="true">{icon}</span>
      <span>Air Remote</span>
      <span style={{ opacity: 0.7 }}>{snapshot.detail === '' ? snapshot.phase : snapshot.detail}</span>
    </div>
  )
}
