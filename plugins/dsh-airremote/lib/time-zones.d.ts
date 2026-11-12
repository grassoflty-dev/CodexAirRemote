/**
 * 时区表（设置页下拉项与 host 自动对时共用）。
 *
 * 单位是「分钟、东为正」，与固件 `AR1Z <minutes>` 一致（480 = UTC+8）。
 * 本模块必须保持无副作用、不 import node 内置模块：浏览器 bundle 和 host 都会引它。
 * `auto` 表示跟随当前运行环境的系统时钟；未知 id 也按系统时钟处理，与设置页回退一致。
 */
/** 时区选项；`minutes` 缺省表示跟随系统。 */
export interface TimezoneOption {
    id: string;
    label: string;
    minutes?: number;
}
/** 没保存过时区、或保存值不认识时的默认项。 */
export declare const DEFAULT_TIMEZONE = "auto";
/** 固件接受的分钟范围（东为正，UTC−12:00..UTC+14:00）。 */
export declare const MIN_TIMEZONE_MINUTES = -720;
export declare const MAX_TIMEZONE_MINUTES = 840;
/** 设置页展示的顺序，固定项之外不要随便增删（已存进 `time.json` 的 id 要能继续识别）。 */
export declare const TIMEZONE_OPTIONS: readonly TimezoneOption[];
/** 当前环境的时区偏移（分钟、东为正），夹到固件接受的范围内。 */
export declare function systemOffsetMinutes(now?: Date): number;
/** 当前环境的 IANA 时区名，只用于日志；取不到时回 `system`。 */
export declare function systemTimezoneName(): string;
/**
 * 把设置里的时区 id 换成 `AR1Z` 需要的分钟偏移。
 * 固定项直接用表里的值；`auto`、未知 id 都跟随系统时钟（与设置页的回退行为一致）。
 */
export declare function minutesForTimezone(id: string, now?: Date): number;
