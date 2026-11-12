/**
 * One board voice session: discover, AUTH, CAPTURE, then pull PCM frames until
 * the browser stops. The protocol is strictly request/response because the
 * firmware's `send_audio` drains its ring only when it receives `PULL`.
 */
import { BoardDiscovery } from './discovery.js';
import type { AirRemoteHostConfig } from './config.js';
export type BoardState = 'discovering' | 'connecting' | 'authenticating' | 'arming' | 'live' | 'finishing' | 'ended' | 'error';
export type BoardEndReason = 'draft' | 'cancelled' | 'error' | 'timeout' | 'closed';
export interface BoardSessionEvents {
    onState?: (state: BoardState, detail: string) => void;
    onPcm?: (pcm: Buffer, sequence: number) => void;
    onEnd?: (reason: BoardEndReason, detail: string) => void;
}
export interface SimulationTarget {
    host: string;
    port: number;
}
export interface BoardSessionOptions {
    config: AirRemoteHostConfig;
    discovery?: BoardDiscovery;
    simulation?: SimulationTarget;
    events?: BoardSessionEvents;
}
export declare class BoardSession {
    private ws;
    private state;
    private readonly events;
    private readonly config;
    private readonly discovery;
    private readonly simulation;
    private ended;
    private captureComplete;
    private terminalSent;
    private pullOutstanding;
    private sequenceSeen;
    private stopRequested;
    private authTimer;
    private goTimer;
    private firstAudioTimer;
    private pullTimer;
    private pullTimeout;
    private ackTimer;
    private maxTimer;
    private endResolve;
    private readonly endPromise;
    constructor(options: BoardSessionOptions);
    /** Resolves when the session ends, for either side's reason. */
    get finished(): Promise<{
        reason: BoardEndReason;
        detail: string;
    }>;
    get currentState(): BoardState;
    private setState;
    start(): Promise<void>;
    private resolveTarget;
    private loadCa;
    private timeout;
    private clearTimers;
    private onMessage;
    private schedulePull;
    private pull;
    /** Ask the board to stop; resolves once the session has ended. */
    stop(options?: {
        draft: boolean;
    }): Promise<void>;
    private finish;
    get lastSequence(): number;
}
