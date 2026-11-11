import { useEffect, useState } from 'react'
import type { VoiceState } from './voice-state.js'

export interface AirRemoteBarProps {
  voiceState?: VoiceState
}

/** Dock bar under the composer: shows the voice pipeline state and last transcript. */
export function AirRemoteBar({ voiceState }: AirRemoteBarProps) {
  const [snapshot, setSnapshot] = useState(() => voiceState?.get() ?? { phase: 'idle' as const, detail: '', lastTranscript: '' })

  useEffect(() => {
    if (voiceState === undefined) return
    const unsubscribe = voiceState.subscribe(() => setSnapshot(voiceState.get()))
    return unsubscribe
  }, [voiceState])

  if (snapshot.phase === 'idle') return null

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
      <span aria-hidden="true">{snapshot.phase === 'error' ? '⚠️' : '🎙'}</span>
      <span>{snapshot.detail === '' ? snapshot.phase : snapshot.detail}</span>
      {snapshot.lastTranscript === '' ? null : <span style={{ opacity: 0.7 }}>「{snapshot.lastTranscript}」</span>}
    </div>
  )
}
