/**
 * `/airremote/audio` upgrade route.
 *
 * The browser shim connects here, sends `{type:"start"}` when the official
 * voice-input plugin constructs its MediaRecorder, and receives the board's
 * 16 kHz mono PCM as binary frames. Control/state messages are JSON text.
 */
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { BoardDiscovery } from './discovery.js';
import { type SimulationTarget } from './board-session.js';
import type { AirRemoteHostConfig } from './config.js';
export interface AudioRouteOptions {
    config: AirRemoteHostConfig;
    discovery?: BoardDiscovery;
    simulation?: SimulationTarget;
    logger?: (message: string) => void;
}
export declare class AudioRoute {
    private active;
    private disposed;
    private readonly options;
    constructor(options: AudioRouteOptions);
    /** `webServer.registerUpgrade` handler. */
    readonly handler: (req: IncomingMessage, socket: Duplex, head: Buffer) => void;
    /**
     * The route lives on the local DSH web server, whose upgrade path is outside
     * the page's cookie fence. Refuse cross-site WebSocket handshakes so another
     * local origin cannot open the board microphone; Node clients (tests) send no
     * Origin and are allowed.
     */
    private originAllowed;
    private start;
    private sendJson;
    dispose(): void;
}
