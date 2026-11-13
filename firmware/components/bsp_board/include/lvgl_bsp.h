#pragma once

#include "lvgl.h"
#include "display_bsp.h"

void Lvgl_PortInit(DisplayPort &display);
void Lvgl_Refresh(void);
esp_err_t Lvgl_lock(int timeout_ms);
void Lvgl_unlock(void);

#ifdef __cplusplus
extern "C" {
#endif

/* LVGL display created by Lvgl_PortInit(), or NULL before it ran. */
lv_display_t *Lvgl_GetDisplay(void);

/* Screen orientation in 90 degree steps (0/90/180/270, anything else is
 * snapped down to the nearest step). RAM only: nothing is stored in NVS and a
 * power cycle always comes back at 0.
 *
 * 旋转由面板 SH8601 的 MADCTL(0x36) 在硬件里完成（display_bsp.cpp 的
 * Set_Rotate()）：像素数据原样送 SPI，flush 里不再转置，因此没有 DMA scratch
 * 缓冲区。lv_display_set_rotation() 仍然调用，负责更新逻辑分辨率（480x480
 * 方形屏）和让 LVGL 重绘，并让 LVGL 用它自己的 lv_display_rotate_point() 把
 * 触摸原始坐标变换回逻辑坐标（src/indev/lv_indev.c:763-768），所以触摸永远
 * 和画面同向，触摸 read_cb 里不需要再做任何旋转。
 *
 * Returns the rotation that is actually applied (the previous one when the
 * MADCTL write failed). Must be called with the LVGL lock held. */
int Lvgl_SetDisplayRotation(int degrees);
int Lvgl_GetDisplayRotation(void);

#ifdef __cplusplus
}
#endif
