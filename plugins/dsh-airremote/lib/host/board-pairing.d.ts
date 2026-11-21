export declare const BOARD_TLS_NAME = "airremote.local";
export interface BoardPairing {
    token: string;
    certificate: string;
    fingerprint: string;
}
/** 只接受板子经 USB 提供的、有效且自签名的设备证书。 */
export declare function validateBoardPairing(token: unknown, certificate: string | Buffer): BoardPairing;
export declare function readBoardPairing(dataDir: string): BoardPairing | undefined;
export declare function writeBoardPairing(dataDir: string, pairing: BoardPairing): void;
/** 不把包含令牌的整行放进异常、HTTP 结果或日志。 */
export declare function parsePairingReply(line: string, nonce: string): BoardPairing | undefined;
