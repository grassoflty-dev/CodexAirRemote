import type { Context } from '@deepseek-ai/cordis'
import { AirRemoteBar } from './AirRemoteBar.js'
import { AirRemoteSettings, AirRemoteSettingsIcon } from './AirRemoteSettings.js'
import { createVoiceState } from './voice-state.js'
import { installVirtualMicrophone } from './virtual-mic.js'

/**
 * Client entry: install the virtual microphone that the official DSH
 * voice-input plugin consumes. There is deliberately no microphone button here —
 * the official plugin owns the trigger, recording UI and recognition.
 *
 * Settings contributes exactly one section ("Air remote") holding the board
 * clock and the firmware flasher, plus its rail icon.
 */

/** Locale namespace for the settings rail entry; DSH resolves `label` with it. */
const LOCALE_NAMESPACE = 'settings.airremote'
const DICTIONARIES: Record<string, Record<string, string>> = {
  en: { nav: 'Air remote (ESP32-C6)' },
  zh: { nav: 'Air Remote 语音遥控板' }
}

interface LocaleService {
  register(namespace: string, dictionaries: Record<string, Record<string, string>>): () => void
  bind(namespace: string): (key: string) => string
}

export const inject = ['slots', 'locale']

export async function apply(ctx: Context): Promise<void> {
  const voiceState = createVoiceState()
  const disposeMicrophone = installVirtualMicrophone({ status: voiceState })
  ctx.effect(() => disposeMicrophone, 'dsh-airremote virtual microphone')

  const locale = (ctx as unknown as { locale: LocaleService }).locale
  ctx.effect(() => locale.register(LOCALE_NAMESPACE, DICTIONARIES), 'dsh-airremote locale')
  const t = locale.bind(LOCALE_NAMESPACE)

  ctx.slots.inject('conversation.input.dock', () =>
    ctx.slots.register(
      {
        name: 'conversation.input.dock',
        id: 'dsh-airremote-status',
        order: 16,
        inject: () => ({ voiceState })
      },
      AirRemoteBar as never
    )
  )

  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      {
        name: 'settings.section',
        id: 'airremote',
        order: 40,
        label: () => t('nav'),
        locale: LOCALE_NAMESPACE
      },
      AirRemoteSettings as never
    )
  )

  ctx.slots.inject('settings.section.icon', () =>
    ctx.slots.register(
      {
        name: 'settings.section.icon',
        id: 'airremote'
      },
      AirRemoteSettingsIcon as never
    )
  )
}
