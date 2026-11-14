/**
 * 「内置固件」的 HTTP 路由（contract: `/airremote/firmware/manifest`、`/airremote/firmware/image`）。
 *
 * 插件包里带一份从 0x0 整体烧写的合并镜像（`firmware/codex_air_remote-merged.bin`）
 * 和它的描述文件（`firmware/manifest.json`），由 `scripts/bundle-firmware.mjs` 在开发机生成。
 * 浏览器端用 Web Serial 把镜像流式写进板子，host 只负责静态下发：
 *
 *  - `GET /airremote/firmware/manifest` → manifest.json（缺少 / 损坏 → 503）
 *  - `GET /airremote/firmware/image`    → 合并镜像，**流式**读盘（不 readFile 进内存）
 *
 * 这里不碰串口、不调用 idf/esptool、不留定时器。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
/** 合并镜像的文件名（相对 `firmwareDir`）。 */
export declare const FIRMWARE_IMAGE_FILE = "codex_air_remote-merged.bin";
/** manifest 的文件名（相对 `firmwareDir`）。 */
export declare const FIRMWARE_MANIFEST_FILE = "manifest.json";
/** 合并镜像里可以直接按偏移烧写的一段（bootloader / 分区表 / ota_data / app）。 */
export interface FirmwareFlashRegion {
    /** 该段在合并镜像中的起始偏移，同时也是 flash 落地偏移。 */
    offset: number;
    /** 该段的字节数。 */
    size: number;
    /** 段名，仅用于日志与校验（如 `bootloader`、`app`）。 */
    name: string;
}
/** NVS 分区范围（0x9000..0x107000）：烧录绝不能写这一段，否则会清掉配对/配网/时区。 */
export declare const NVS_FLASH_START = 36864;
export declare const NVS_FLASH_END = 1077248;
/** 与契约一致的 manifest 形状。 */
export interface FirmwareManifest {
    /** 产出这份固件的插件（固定 `dsh-airremote`）。 */
    plugin: string;
    /** 目标芯片，如 `esp32c6`。 */
    chip: string;
    /** 固件语义版本 `MAJOR.MINOR.PATCH`。 */
    version: string;
    /** 构建时的 git 短 hash。 */
    commit: string;
    /** 整体烧写偏移，恒为 0。 */
    flashOffset: number;
    /** 镜像字节数。 */
    size: number;
    /** 镜像 sha256（小写 hex），同时用作 ETag。 */
    sha256: string;
    /** 构建时间（ISO 8601）。 */
    builtAt: string;
    /**
     * 分段烧写表（可选）。存在时插件按段烧写并跳过 NVS；缺省时退回整片 0x0 烧写
     * （会擦 NVS，仅用于旧镜像兼容）。
     */
    regions?: FirmwareFlashRegion[];
}
export interface FirmwareRouteOptions {
    /** 插件包根下的 `firmware/` 目录（绝对路径）。 */
    firmwareDir: string;
    /** 正常事件（如一次成功下发）。 */
    log?: (message: string) => void;
    /** 异常事件；不抛错，只记录。 */
    warn?: (message: string) => void;
}
/** 自检结果里的一条问题（中文，带绝对路径，直接可打日志）。 */
export interface FirmwareProblem {
    /** 缺什么 / 哪里不对。 */
    code: 'manifest-missing' | 'manifest-invalid' | 'image-missing' | 'size-mismatch';
    /** 给人看的中文说明。 */
    message: string;
    /** 相关文件绝对路径。 */
    path: string;
}
export declare class FirmwareRoutes {
    private readonly options;
    private cached;
    constructor(options: FirmwareRouteOptions);
    /** 合并镜像的绝对路径。 */
    get imagePath(): string;
    /** manifest 的绝对路径。 */
    get manifestPath(): string;
    /** `GET /airremote/firmware/manifest`。 */
    readonly manifestHandler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
    /** `GET /airremote/firmware/image`；支持 `If-None-Match` → 304。 */
    readonly imageHandler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
    /**
     * 启动自检：manifest 能不能读、bin 在不在、大小对不对。
     * 返回问题列表（空数组 = 一切正常）；**不抛错**，调用方只打日志。
     */
    selfCheck(): Promise<FirmwareProblem[]>;
    /** 读 manifest：按 mtime+size 缓存，烧录期间会连读两次，不重复解析。 */
    private readManifest;
    /** 与 `time-routes.ts` 相同的同源策略。 */
    private originAllowed;
    private rejectForeignOrigin;
    private sendUnavailable;
    private sendJson;
}
