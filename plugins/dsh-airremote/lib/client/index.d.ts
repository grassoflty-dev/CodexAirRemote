import type { Context } from '@deepseek-ai/cordis';
/**
 * Client entry: install the virtual microphone that the official DSH
 * voice-input plugin consumes. There is deliberately no microphone button here
 * — the official plugin owns the trigger, recording UI and recognition.
 */
export declare const inject: string[];
export declare function apply(ctx: Context): Promise<void>;
