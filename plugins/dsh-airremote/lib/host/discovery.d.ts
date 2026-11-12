/**
 * UDP discovery for the ESP32-C6 voice session (`voice.c`):
 *
 *   board -> host   `AR1A` + 6-byte MAC, sent to the gateway and broadcast on 47682
 *   host  -> board  `AR1?` + 16 bytes, answered with the same payload where byte 3 is `!`
 *
 * The board announces every 500 ms for up to 20 s after the user starts a voice
 * session, so a browser session that starts a little later can still attach.
 */
export interface BoardAnnouncement {
    host: string;
    mac: string;
    at: number;
}
export interface BoardDiscoveryOptions {
    port: number;
    /** Also probe with an `AR1?` broadcast while waiting (helps on networks that drop board broadcasts). */
    probe?: boolean;
}
export declare class BoardDiscovery {
    private readonly options;
    private socket;
    private probeTimer;
    private readonly waiters;
    private last;
    private closed;
    private readonly probe;
    constructor(options: BoardDiscoveryOptions);
    get latest(): BoardAnnouncement | undefined;
    start(): Promise<void>;
    /** Wait for the next announcement, or use one seen within `maxAgeMs`. */
    wait(timeoutMs: number, maxAgeMs?: number): Promise<BoardAnnouncement>;
    close(): void;
}
