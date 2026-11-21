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
import { type BoardPairing } from './board-pairing.js';
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
interface PortInfo {
    path?: string;
    vendorId?: string;
}
/** `serialport` 不可用时的原因（空串表示可用或还没探测过），用于日志与排查。 */
export declare function serialportFailureReason(): string;
/** `serialport` 不可用时的错误码（`serial-native-missing` / `serialport-unavailable`）。 */
export declare function serialportFailureCode(): string;
/** 串口模块探测结果；`ok:false` 时带可操作文案。 */
export interface SerialportProbe {
    ok: boolean;
    code?: string;
    message?: string;
    /** 原始错误信息（只进日志，不进 UI 主文案）。 */
    detail?: string;
}
/**
 * 区分「原生模块没装/没找到」与其它串口错误。
 * 前者通常发生在：DSH 正在运行时更新插件 → pnpm 替换 `@serialport/bindings-cpp`
 * 被 Windows 文件锁挡住（ERR_PNPM_EPERM）→ 目录短暂不完整 → require 找不到。
 */
export declare function classifySerialportFailure(error: unknown): {
    code: string;
    message: string;
};
/** 探测一次串口模块；`load` 仅供单测注入失败路径。 */
export declare function probeSerialport(load?: () => unknown): Promise<SerialportProbe>;
/**
 * 找一个 ESP32-C6 的串口。
 *
 * `preferred` 非空时直接用它（配置 / 环境变量里的显式指定）；
 * 否则先问 `serialport`，再兜底查注册表，最后退到 CIM 的 PnP 设备。
 * 全部失败返回 null——**不**把「只有一个串口」当作识别成功。
 */
export declare function findBoardPort(preferred?: string): Promise<string | null>;
/** 一个可用于「扫描设备」的串口候选。 */
export interface BoardPortInfo {
    path: string;
    vendorId?: string;
    productId?: string;
}
/** `GET /airremote/ports` 的结果；`ok:false` 表示枚举本身失败（不是没插板）。 */
export interface BoardPortScan {
    ok: boolean;
    ports: BoardPortInfo[];
    board: string | null;
    code?: string;
    message?: string;
    /** 串口模块本身是否可用（即使退化到注册表枚举也会如实报告）。 */
    serial: SerialportProbe;
}
/**
 * 枚举串口并找出 ESP32-C6（VID 303A）——**只 list，不打开端口**，不占串口锁。
 * `list`/`fallback` 仅用于测试注入；生产走 `SerialPort.list()` + 注册表/PnP 兜底。
 */
export declare function listBoardPorts(options?: {
    list?: () => Promise<PortInfo[]>;
    fallback?: () => Promise<string[]>;
}): Promise<BoardPortScan>;
/**
 * 通过串口把 UTC 秒和显示时区写给板子：`AR1T <unix>` → `AR1Z <minutes>`。
 * 每条命令都要读到 OK；板子回 ERR 抛 `rejected`，等不到抛 `timeout`。
 * 端口在 finally 里关闭，不留在后台。
 */
export declare function syncBoardTime(port: string, unixSeconds: number, minutes: number): Promise<BoardSyncResult>;
/** 只配对唯一的原生 ESP32-C6 USB 端口，不走会留命令输出的 PowerShell。 */
export declare function pairBoardUsb(rotate: boolean): Promise<BoardPairing | undefined>;
export {};
