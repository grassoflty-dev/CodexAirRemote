/**
 * 开发板时区偏好（`<dataDir>/time.json`）。
 *
 * 这里只保存用户选的时区 id、自动对时开关和写入时间；host 不解释 IANA 时区，
 * 「跟随系统」的分钟偏移由 `time-zones.ts` 按运行环境算。
 * 文件缺失或损坏一律回落到默认值且不抛错——设置页永远能打开。
 */
/** 自动对时默认开启：板子 RTC 断电后是 2000-01-01，不校准就一直显示 `--:--`。 */
export declare const DEFAULT_AUTO_SYNC = true;
export interface TimePreference {
    /** 时区 id；未保存过时为 `auto`。 */
    timezone: string;
    /** 连上开发板是否自动校准时间；未保存过时为 `true`。 */
    autoSync: boolean;
    /** 上次写入的 ISO 时间；未保存过时为 `null`。 */
    updatedAt: string | null;
}
/** `POST /airremote/time` 允许只改其中一项，另一项沿用文件里的值。 */
export interface TimePreferencePatch {
    timezone?: string;
    autoSync?: boolean;
}
/** `<dataDir>/time.json` 的绝对路径。 */
export declare function timePreferenceFile(dataDir: string): string;
/** 校验一个时区 id 是否符合契约允许的形状。 */
export declare function isTimezoneId(value: unknown): value is string;
/**
 * 读取保存的偏好。文件不存在、不是 JSON、字段类型不对时都按默认值处理。
 * `autoSync` 只认布尔值，其余（含缺失）一律视为默认的「开启」。
 */
export declare function readTimePreference(dataDir: string): TimePreference;
/**
 * 写偏好：先读旧值把没传的字段补上，再「写 `time.json.tmp` + 同目录 rename」原子落盘，
 * 读者不会看到半个文件。返回实际落盘的内容（时区统一存小写）。
 */
export declare function writeTimePreference(dataDir: string, patch: TimePreferencePatch): TimePreference;
