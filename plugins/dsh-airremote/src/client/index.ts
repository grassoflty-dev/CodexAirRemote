import type { Context } from '@deepseek-ai/cordis'
import { AirRemoteButton, type AirRemoteButtonProps } from './AirRemoteButton.js'
import { AirRemoteBar } from './AirRemoteBar.js'
import { createVoiceState } from './voice-state.js'

/**
 * Client entry: owns the UI contribution lifecycle.
 * `slots` is the only required client service for M1 (fake ASR). Later
 * milestones add `remote` (board link + whisper worker RPC) and `locale`.
 */
export const inject = ['slots']

export async function apply(ctx: Context): Promise<void> {
  const voiceState = createVoiceState()

  ctx.slots.inject('conversation.input.right', () =>
    ctx.slots.register(
      {
        name: 'conversation.input.right',
        id: 'dsh-airremote-voice',
        order: 31,
        inject: (sessionId: string) => ({ voiceState, sessionId })
      },
      AirRemoteButton as never
    )
  )

  ctx.slots.inject('conversation.input.dock', () =>
    ctx.slots.register(
      {
        name: 'conversation.input.dock',
        id: 'dsh-airremote-bar',
        order: 16
      },
      AirRemoteBar as never
    )
  )

  void ({} as AirRemoteButtonProps)
}
