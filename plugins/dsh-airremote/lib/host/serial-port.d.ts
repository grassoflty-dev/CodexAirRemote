/**
 * 串口：识别 ESP32-C6 开发板（USB VID 0x303A）并把时间 / 时区写进去。
 *
 * 两条通道：
 *  - `serialport` npm 包可用时走它（首选）；
 *  - 否则用一次性的 PowerShell 进程（`[System.IO.Ports.SerialPort]`），
 *    一个脚本完成打开 / 写 / 读到匹配 / 关闭，用独特分隔符回传结果。
 *
 * 只做一次性动作：不轮询、不监听插拔、不留后台定时器。
 */
/** Espressif 的 USB VID。固件用 USB-Serial/JTAG，端口一定挂在它下面。 */
export declare const ESPRESSIF_VENDOR_ID = "303A";
/** 与 `voice.c` 的串口命令一致：115200 8N1，无流控。 */
export declare const BOARD_BAUD_RATE = 115200;
export type BoardSyncErrorCode = 'open-failed' | 'timeout' | 'rejected' | 'internal';
/** 同步失败：`code` 直接对应契约里的错误码。 */
export declare class BoardSyncError extends Error {
    readonly code: BoardSyncErrorCode;
    /** 已经收到 / 发出的原始行，便于界面上排查。 */
    readonly lines: string[];
    constructor(code: BoardSyncErrorCode, message: string, lines?: string[]);
}
export interface BoardSyncResult {
    /** 发出去的命令行。 */
    sent: string[];
    /** 从板子读到的行（含开机日志）。 */
    lines: string[];
}
/** `serialport` 不可用时的原因（空串表示可用或还没探测过），用于日志与排查。 */
export declare function serialportFailureReason(): string;
/**
 * 找一个 ESP32-C6 的串口。
 *
 * `preferred` 非空时直接用它（配置 / 环境变量里的显式指定）；
 * 否则先问 `serialport`，再兜底查注册表，最后退到 CIM 的 PnP 设备。
 * 全部失败返回 null——**不**把「只有一个串口」当作识别成功。
 */
export declare function findBoardPort(preferred?: string): Promise<string | null>;
/**
 * 通过串口把 UTC 秒和显示时区写给板子：`AR1T <unix>` → `AR1Z <minutes>`。
 * 每条命令都要读到 OK；板子回 ERR 抛 `rejected`，等不到抛 `timeout`。
 * 端口在 finally 里关闭，不留在后台。
 */
export declare function syncBoardTime(port: string, unixSeconds: number, minutes: number): Promise<BoardSyncResult>;
