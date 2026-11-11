import type { Context } from '@deepseek-ai/cordis'
import { DEFAULT_SETTINGS } from './config.js'

/**
 * dsh-airremote host entry.
 *
 * M1 (this milestone): only owns the plugin lifecycle + settings presentation;
 * the client half ships the microphone button, page-level shortcut and fake ASR
 * so the draft-injection path can be validated inside DSH web.
 *
 * Planned milestones:
 *  - M2: board link (`AR1A` UDP discovery + TLS/WSS voice server on 47683, reuse
 *        the firmware `voice.c` framing) and PCM hand-off.
 *  - M3: local whisper.cpp worker (@fugood/whisper.node, large-v3/turbo, CUDA),
 *        glossary + optional LLM polish.
 *  - M4: esptool flashing and serial provisioning subprocesses.
 */
export const name = 'dsh-airremote'

/** The settings service owns the profile entry config this plugin reads/writes. */
export const inject = ['settings']

export async function apply(ctx: Context): Promise<void> {
  // The plugin ships its own settings page (later milestone); suppress the
  // auto-generated form for now.
  const disposePresentation = ctx.settings.configure({ auto: false })
  ctx.effect(() => disposePresentation, 'dsh-airremote settings presentation')

  ctx.effect(() => {
    const defaults = DEFAULT_SETTINGS
    ctx.logger?.info?.(
      `dsh-airremote ready (asr=${defaults.asrBackend}, model=${defaults.whisperModel}, port=${defaults.boardVoicePort})`
    )
    return () => undefined
  }, 'dsh-airremote lifecycle')
}
