/**
 * Minimal RFC 6455 WebSocket implementation for the two links this plugin owns:
 *
 *  - browser  -> host: the `dsh-host-webserver` upgrade route (`/airremote/audio`)
 *  - host     -> board: the TLS WebSocket client the ESP32-C6 `voice.c` serves on 47683
 *
 * The plugin deliberately carries no runtime dependency beyond Node builtins, so
 * this file implements the small subset both peers need: the opening handshake,
 * masked client frames, unmasked server frames, text/binary/close/ping/pong, and
 * continuation frames. No extensions (permessage-deflate) are negotiated.
 */
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
export type WsMessage = {
    type: 'text';
    text: string;
} | {
    type: 'binary';
    data: Buffer;
};
export interface WsHandlers {
    onMessage?: (message: WsMessage) => void;
    onClose?: (code: number, reason: string) => void;
    onError?: (error: Error) => void;
}
export interface WsConnection {
    readonly open: boolean;
    sendText(text: string): boolean;
    sendBinary(data: Buffer | Uint8Array): boolean;
    close(code?: number, reason?: string): void;
    terminate(): void;
}
/** Encode one complete (unfragmented) frame. */
export declare function encodeFrame(opcode: number, payload: Buffer, masked: boolean): Buffer;
/** Complete the server-side opening handshake for one `upgrade` event. */
export declare function acceptWebSocket(req: IncomingMessage, socket: Duplex, head: Buffer, handlers: WsHandlers): WsConnection;
export interface BoardTlsOptions {
    /** Trust this PEM chain instead of Node's public roots. */
    ca?: string | Buffer;
    /** Hostname to validate; the board certificate is issued for `airremote.local`. */
    servername?: string;
    /** Accept the board's self-signed certificate without a CA (development only). */
    rejectUnauthorized?: boolean;
}
export interface ConnectWebSocketOptions {
    host: string;
    port: number;
    path: string;
    timeoutMs?: number;
    tls?: BoardTlsOptions;
}
/**
 * Open a WebSocket client. The socket is returned after the 101 response, so
 * callers can send AUTH immediately; connection failures reject.
 */
export declare function connectWebSocket(options: ConnectWebSocketOptions, handlers: WsHandlers): Promise<WsConnection>;
