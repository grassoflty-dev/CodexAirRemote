import re

src_path = r"D:\C-Develop\CodexAirRemote\firmware\components\app_ui\fonts\ui_font_standby_160.c"
out_c = r"D:\C-Develop\CodexAirRemote\firmware\components\app_ui\fonts\standby_glyphs.c"
out_h = r"D:\C-Develop\CodexAirRemote\firmware\components\app_ui\fonts\standby_glyphs.h"

text = open(src_path, "r", encoding="utf-8").read()

bitmap_block = text.split("static LV_ATTRIBUTE_LARGE_CONST const uint8_t glyph_bitmap[] = {", 1)[1]
bitmap_block = bitmap_block.split("};", 1)[0]
bitmap = bytes(int(value, 16) for value in re.findall(r"0x([0-9a-fA-F]{1,2})\b", bitmap_block))

entries = re.findall(
    r"\{\.bitmap_index = (\d+), \.adv_w = (\d+), \.box_w = (\d+), \.box_h = (\d+), "
    r"\.ofs_x = (-?\d+), \.ofs_y = (-?\d+)\}",
    text)
entries = [tuple(int(field) for field in entry) for entry in entries]
assert len(entries) == 12, len(entries)

chars = "0123456789:"
images = []
for index, char in enumerate(chars, start=1):
    bitmap_index, adv_w, box_w, box_h, ofs_x, ofs_y = entries[index]
    stride_src = (box_w + 1) // 2
    stride_dst = (box_w + 3) & ~3
    rows = []
    for y in range(box_h):
        row = bytearray(stride_dst)
        base = bitmap_index + y * stride_src
        for x in range(box_w):
            packed = bitmap[base + x // 2]
            nibble = (packed >> 4) if (x % 2 == 0) else (packed & 0x0F)
            row[x] = nibble * 17
        rows.append(bytes(row))
    images.append((char, adv_w, box_w, box_h, ofs_x, ofs_y, stride_dst, b"".join(rows)))

header = """/* 待机页 160 px 数字的单字形 A8 位图资源（由 ui_font_standby_160.c 生成，
 * 生成脚本见 firmware/tools/gen_standby_glyphs.py）。
 * 为什么不用字体渲染：LVGL 给每个字形分配的 A8 蒙版需要 11~12.5 KB 连续堆，
 * 而 ESP32-C6 在 BLE 连接时只剩 ~15 KB 且碎片化，蒙版分配失败会让该字形
 * 一个像素都画不出来。位图放 flash，绘制不再申请任何堆内存。 */
#pragma once

#include "lvgl.h"

#ifdef __cplusplus
extern "C" {
#endif

/* '0'..'9' 与 ':' 共 11 个字形；其它字符返回 NULL。 */
const lv_image_dsc_t *standby_glyph_image(char glyph);

#ifdef __cplusplus
}
#endif
"""
open(out_h, "w", encoding="utf-8", newline="\n").write(header)

lines = ["#include \"standby_glyphs.h\"", "", "#include <stddef.h>", ""]
lines.append("/* 待机页 160 px 数字的单字形 A8 位图资源（由 ui_font_standby_160.c 生成）。")
lines.append(" * stride 按 4 字节对齐，数据只有 alpha，绘制时用 recolor 染成白色。 */")
lines.append("")
for char, adv_w, box_w, box_h, ofs_x, ofs_y, stride, data in images:
    name = "colon" if char == ":" else "digit_%s" % char
    lines.append("static const uint8_t glyph_%s_map[] = {" % name)
    for offset in range(0, len(data), 16):
        chunk = data[offset:offset + 16]
        lines.append("    " + ", ".join("0x%02x" % value for value in chunk) + ",")
    lines.append("};")
    lines.append("")
    lines.append("const lv_image_dsc_t standby_glyph_%s = {" % name)
    lines.append("    .header.magic = LV_IMAGE_HEADER_MAGIC,")
    lines.append("    .header.cf = LV_COLOR_FORMAT_A8,")
    lines.append("    .header.w = %d," % box_w)
    lines.append("    .header.h = %d," % box_h)
    lines.append("    .header.stride = %d," % stride)
    lines.append("    .data_size = sizeof(glyph_%s_map)," % name)
    lines.append("    .data = glyph_%s_map," % name)
    lines.append("};")
    lines.append("")

lines.append("const lv_image_dsc_t *standby_glyph_image(char glyph)")
lines.append("{")
lines.append("    if (glyph >= '0' && glyph <= '9')")
lines.append("    {")
lines.append("        static const lv_image_dsc_t *digits[10] = {")
for char in "0123456789":
    lines.append("            &standby_glyph_digit_%s," % char)
lines.append("        };")
lines.append("")
lines.append("        return digits[glyph - '0'];")
lines.append("    }")
lines.append("    if (glyph == ':')")
lines.append("    {")
lines.append("        return &standby_glyph_colon;")
lines.append("    }")
lines.append("")
lines.append("    return NULL;")
lines.append("}")
lines.append("")
open(out_c, "w", encoding="utf-8", newline="\n").write("\n".join(lines))

print("glyphs:", [(c, w, h) for c, a, w, h, ox, oy, s, d in images])
print("total bytes:", sum(len(d) for *_, d in images))
