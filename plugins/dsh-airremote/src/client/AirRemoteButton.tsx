import { useCallback, useEffect, useRef, useState } from 'react'
import { DEFAULT_SETTINGS, FAKE_TRANSCRIPT } from '../../config.js'
import { matchesShortcut } from '../../shortcut.js'
import type { VoiceState } from './voice-state.js'

/** Subset of the conversation slot input snapshot we need. */
export interface InputSnapshot {
  draft: string
}

/** Subset of the conversation input actions we need. */
export interface InputActions {
  setDraft(text: string): void
}

export interface AirRemoteButtonProps {
  /** Provided by the `conversation.input.right` slot. */
  useInput?: <T>(selector: (value: InputSnapshot) => T) => T
  /** Provided by the `conversation.input.right` slot. */
  inputActions?: InputActions
  /** Injected by the client entry. */
  voiceState?: VoiceState
  sessionId?: string
}

const FAKE_RECORD_MS = 600
const FAKE_TRANSCRIBE_MS = 400

function appendToDraft(base: string, text: string): string {
  const left = base.trimEnd()
  return left === '' ? text : `${left} ${text}`
}

export function AirRemoteButton(props: AirRemoteButtonProps) {
  const { inputActions, useInput, voiceState } = props
  const draft = useInput?.((value) => value.draft) ?? ''
  const [phase, setPhase] = useState<'idle' | 'listening' | 'transcribing'>('idle')
  const [detail, setDetail] = useState('')
  const draftRef = useRef(draft)
  const busyRef = useRef(false)

  draftRef.current = draft

  useEffect(() => {
    return () => {
      busyRef.current = false
    }
  }, [])

  const cancel = useCallback(() => {
    busyRef.current = false
    setPhase('idle')
    setDetail('已取消')
  }, [])

  const toggle = useCallback(() => {
    if (busyRef.current) {
      cancel()
      return
    }
    busyRef.current = true
    setPhase('listening')
    setDetail('正在录音（假 ASR）…')
    voiceState?.set({ phase: 'listening', detail: '正在录音（假 ASR）…' })

    window.setTimeout(() => {
      if (!busyRef.current) return
      setPhase('transcribing')
      setDetail('正在识别…')
      voiceState?.set({ phase: 'transcribing', detail: '正在识别…' })

      window.setTimeout(() => {
        if (!busyRef.current) return
        busyRef.current = false
        setPhase('idle')
        setDetail('已写入草稿')
        const nextDraft = appendToDraft(draftRef.current, FAKE_TRANSCRIPT)
        draftRef.current = nextDraft
        inputActions?.setDraft(nextDraft)
        voiceState?.set({ phase: 'done', detail: '已写入草稿', lastTranscript: FAKE_TRANSCRIPT })
      }, FAKE_TRANSCRIBE_MS)
    }, FAKE_RECORD_MS)
  }, [cancel, inputActions, voiceState])

  useEffect(() => {
    // M1: page-level hotkey (capture phase so the composer cannot swallow it).
    // Matches dsh-ears behavior: never fires inside dialogs or hidden pages.
    const onKeyDown = (event: KeyboardEvent) => {
      if (!DEFAULT_SETTINGS.voiceShortcutEnabled) return
      if (event.isComposing || event.repeat) return
      if (!matchesShortcut(DEFAULT_SETTINGS.voiceShortcut, event)) return
      const target = event.target
      if (target instanceof Element && target.closest('[role="dialog"]') !== null) return
      if (document.visibilityState !== 'visible') return
      event.preventDefault()
      event.stopPropagation()
      toggle()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [toggle])

  const active = phase !== 'idle'
  return (
    <button
      type="button"
      aria-label="Air Remote 语音输入"
      title={`Air Remote 语音输入（${DEFAULT_SETTINGS.voiceShortcut.replace(/\+/g, '+')}；M1 假 ASR）${detail === '' ? '' : `：${detail}`}`}
      aria-pressed={active}
      onClick={toggle}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        border: '1px solid currentColor',
        borderRadius: '8px',
        padding: '4px 8px',
        background: active ? 'rgba(64, 128, 255, 0.15)' : 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        fontSize: '12px',
        lineHeight: 1.4
      }}
    >
      <span aria-hidden="true">{active ? '●' : '🎙'}</span>
      <span>{active ? (phase === 'listening' ? '录音中' : '识别中') : 'Air Remote'}</span>
    </button>
  )
}
