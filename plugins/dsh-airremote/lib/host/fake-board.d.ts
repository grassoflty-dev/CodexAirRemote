/**
 * In-process simulated board.
 *
 * It speaks the same request/response protocol as `firmware/components/app_voice/voice.c`
 * (`AUTH`/`READY2`/`CAPTURE`/`GO`/`PULL`/`ABORT`/`ACK`) over a plain WebSocket,
 * announces itself on the UDP discovery port, and loops a WAV file (or a
 * synthesized tone when no file exists). This makes the whole host -> browser
 * path testable without hardware.
 */
export interface FakeBoardOptions {
    host?: string;
    port: number;
    token: string;
    wavPath: string;
    discoveryPort: number;
}
export declare class FakeBoard {
    private server;
    private udp;
    private announceTimer;
    private readonly sockets;
    private pcm;
    private offset;
    private sequence;
    private nextFrameAt;
    private readonly host;
    private readonly options;
    constructor(options: FakeBoardOptions);
    get address(): {
        host: string;
        port: number;
    };
    start(): Promise<void>;
    private accept;
    private announce;
    stop(): void;
}
