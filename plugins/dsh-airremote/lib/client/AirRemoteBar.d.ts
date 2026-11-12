import type { VoiceState } from './voice-state.js';
export interface AirRemoteBarProps {
    voiceState?: VoiceState;
}
/** Dock hint under the composer: explains the Air Remote link while the official mic is active. */
export declare function AirRemoteBar({ voiceState }: AirRemoteBarProps): import("react").JSX.Element | null;
