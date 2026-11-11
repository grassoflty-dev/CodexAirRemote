/** dsh-airremote plugin settings (host side defaults; the settings page edits these). */

export interface AirRemoteSettings {
  /** Page-level shortcut toggle. */
  voiceShortcutEnabled: boolean
  /** Canonical chord, e.g. `ctrl+shift+space`. */
  voiceShortcut: string
  /** Minimum recording length in milliseconds before transcription starts. */
  minRecordMs: number
  /** Longest single recording, seconds. */
  maxRecordSeconds: number
  /** ASR backend: `fake` for M1 smoke tests, `whisper` for local whisper.cpp. */
  asrBackend: 'fake' | 'whisper'
  /** whisper model id, e.g. large-v3 / turbo. */
  whisperModel: string
  /** Acceleration: default / vulkan / cuda. */
  whisperAcceleration: 'default' | 'vulkan' | 'cuda'
  /** BCP-47-ish language hint (`auto` = detect). */
  language: string
  /** Glossary terms that ASR/polish should prefer. */
  glossary: string[]
  /** Ask the DSH agent model to polish the raw transcript. */
  polishingEnabled: boolean
  /** Board TLS/WSS voice endpoint port. */
  boardVoicePort: number
  /** UDP discovery port used by the board (`AR1A`). */
  boardDiscoveryPort: number
  /** Flashing: board serial port, empty = auto-detect. */
  flashPort: string
}

export const DEFAULT_SETTINGS: AirRemoteSettings = {
  voiceShortcutEnabled: true,
  voiceShortcut: 'ctrl+shift+space',
  minRecordMs: 300,
  maxRecordSeconds: 120,
  asrBackend: 'fake',
  whisperModel: 'large-v3',
  whisperAcceleration: 'cuda',
  language: 'auto',
  glossary: ['Codex Air Remote', 'DeepSeek Harness', 'ESP32-C6', 'whisper.cpp'],
  polishingEnabled: false,
  boardVoicePort: 47683,
  boardDiscoveryPort: 47682,
  flashPort: ''
}

/** Fixed transcript used by the M1 fake backend. */
export const FAKE_TRANSCRIPT = '这是一段来自 Codex Air Remote 的测试语音。'
