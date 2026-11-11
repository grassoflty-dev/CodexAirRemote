import type { Context } from '@deepseek-ai/cordis'
import { AirRemoteBar } from './AirRemoteBar.js'
import { DevBoardTime } from './DevBoardTime.js'
import { FirmwareFlash } from './FirmwareFlash.js'
import { createVoiceState } from './voice-state.js'
import { installVirtualMicrophone } from './virtual-mic.js'

/**
 * Client entry: install the virtual microphone that the official DSH
 * voice-input plugin consumes. There is deliberately no microphone button here
 * — the official plugin owns the trigger, recording UI and recognition.
 */
export const inject = ['slots']

export async function apply(ctx: Context): Promise<void> {
  const voiceState = createVoiceState()
  const disposeMicrophone = installVirtualMicrophone({ status: voiceState })
  ctx.effect(() => disposeMicrophone, 'dsh-airremote virtual microphone')

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
        id: 'airremote-time',
        order: 40,
        label: '开发板时间'
      },
      DevBoardTime as never
    )
  )

  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      {
        name: 'settings.section',
        id: 'airremote-firmware',
        order: 41,
        label: '固件烧录'
      },
      FirmwareFlash as never
    )
  )
}
