/* 待机页 160 px 数字的单字形 A8 位图资源（由 ui_font_standby_160.c 生成，
 * 生成脚本见 firmware/tools/gen_standby_glyphs.py）。
 * 为什么不用字体渲染：LVGL 给每个字形分配的 A8 蒙版需要 11~12.5 KB 连续堆，
 * 而 ESP32-C6 在 BLE 连接时只剩 ~15 KB 且碎片化，蒙版分配失败会让该字形
 * 一个像素都画不出来。位图放 flash，绘制不再申请任何堆内存。
 * 资源不变量：A8、1 字节/像素、stride == box_w（无行填充），app_ui 开机时逐字节
 * 与字体原始 4bpp 数据（连续打包）比对，任何差异都会打 E GLYPH MISMATCH。 */
#pragma once

#include "lvgl.h"

#ifdef __cplusplus
extern "C" {
#endif

/* 160 px 数字字体：位图由 standby_glyphs.c 的 A8 资源提供，字体本身只用
 * 来取字形度量（adv_w/ofs_x/ofs_y/box_w/box_h）与行高。 */
extern const lv_font_t ui_font_standby_160;

/* '0'..'9' 与 ':' 共 11 个字形；其它字符返回 NULL。 */
const lv_image_dsc_t *standby_glyph_image(char glyph);

#ifdef __cplusplus
}
#endif
