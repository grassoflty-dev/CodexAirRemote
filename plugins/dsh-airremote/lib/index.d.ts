import type { Context } from '@deepseek-ai/cordis';
import { type AirRemoteHostConfigOverrides } from './host/config.js';
/**
 * dsh-airremote host entry.
 *
 * The host owns the board link and exposes it to the page over the
 * `dsh-host-webserver` upgrade route `/airremote/audio`. The client half
 * installs a synthetic microphone and feeds the official DSH voice-input
 * plugin, so this plugin never renders its own microphone button.
 */
export declare const name = "dsh-airremote";
/** The upgrade route needs the Web carrier; headless profiles simply do not load this plugin. */
export declare const inject: string[];
export declare function apply(ctx: Context, config?: AirRemoteHostConfigOverrides): Promise<void>;
