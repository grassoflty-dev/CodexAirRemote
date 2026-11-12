/**
 * host 侧固件烧录：esptool-js + node-serialport，真机走 USB-Serial/JTAG（ESP32-C6）。
 *
 * 浏览器不再用 Web Serial 烧录，改由宿主进程独占串口：
 *  - 校验内置镜像：读 `firmware/codex_air_remote-merged.bin` + `manifest.json`，
 *    **host 自己算 sha256 与 manifest 比对**（前端传来的东西一律不信）。
 *  - `fileArray: [{ data, address: 0 }]`、`flashSize/flashMode/flashFreq: 'keep'`、
 *    `eraseAll: false`、`compress: true`；带 `calculateMD5Hash` 让 esptool 写完做 MD5 校验。
 *  - 烧完必须 **关串口 + EN 硬复位**，否则芯片停在 stub，板子不跑 App。
 *  - 取消（`AbortSignal`）和任何异常都走 finally：释放串口 → EN 复位，绝不留独占句柄。
 *
 * 错误码与契约一致：no-board | open-failed | timeout | rejected | busy | internal |
 * sha256-mismatch | cancelled。
 */
import { type FirmwareManifest } from './firmware-routes.js';
/**
 * 烧录用的名义波特率。
 *
 * USB-Serial/JTAG 上这个数字只是「名义值」：数据走 USB 全速，改不改都不影响实际吞吐。
 * 460800 的风险在于 `ESPLoader` 发现 `romBaudrate !== baudrate` 时会走 `changeBaud()`：
 * 先发 ESP_CHANGE_BAUDRATE，再让 Transport 改宿主侧波特率（我们的设备实现了
 * `setBaudRate`，所以是就地 `update()`，不重开端口），然后读寄存器确认响应；
 * 读不到就 disconnect + 按 115200 重连并重传 stub。这条回退链在真机上验证过（见交付报告）。
 */
export declare const FLASH_BAUD_RATE = 460800;
/** 与 manifest 对不上的错误码。 */
export type FlashErrorCode = 'no-board' | 'open-failed' | 'timeout' | 'rejected' | 'busy' | 'internal' | 'sha256-mismatch' | 'cancelled';
/** 烧录失败：`code` 直接对应契约里的错误码，`message` 是给人看的中文。 */
export declare class FlashError extends Error {
    readonly code: FlashErrorCode;
    constructor(code: FlashErrorCode, message: string);
}
export interface FlashFirmwareOptions {
    /** 插件包根下的 `firmware/` 目录（绝对路径）。 */
    firmwareDir: string;
    /** 目标串口，如 `COM7`。 */
    port: string;
    /** esptool 原始输出逐行回调（`onLine` 里抛错不会影响烧录）。 */
    onLine?: (line: string) => void;
    /** 进度 0..100（附带已写 / 总字节数，总字节数是压缩后的传输量）。 */
    onProgress?: (percent: number, written: number, total: number) => void;
    /** 取消信号：在进度回调里检查，抛 `cancelled`。 */
    signal?: AbortSignal;
    /** 测试 / 调参用；默认见 `FLASH_BAUD_RATE` / `ROM_BAUD_RATE`。 */
    baudRate?: number;
    romBaudRate?: number;
    /** 非致命告警（如 EN 复位失败）；烧录本身已经成功时不因此判失败。 */
    onWarn?: (message: string) => void;
}
export interface FlashResult {
    port: string;
    /** 从开始校验镜像到芯片复位完成的秒数（一位小数）。 */
    seconds: number;
    /** 实际烧进 flash 的镜像 sha256（与 manifest 一致）。 */
    sha256: string;
    /** 镜像字节数（未压缩）。 */
    bytes: number;
}
interface LoadedImage {
    manifest: FirmwareManifest;
    data: Uint8Array;
}
/**
 * 读并校验内置固件。sha256 在 host 侧重算，和 manifest 不一致直接拒绝——
 * 这样镜像被截断 / 换包 / 半写入都不会烧进板子。
 */
export declare function loadFirmwareImage(firmwareDir: string): Promise<LoadedImage>;
/**
 * 烧录内置合并镜像。
 *
 * 副作用：占用串口 → 校验镜像 → 连接芯片（必要时上传 stub）→ 写 flash → MD5 校验 →
 * 关串口 → EN 硬复位。无论成功、失败、取消，串口都会被关掉并复位芯片。
 */
export declare function flashFirmware(options: FlashFirmwareOptions): Promise<FlashResult>;
export {};
