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
 * 立即应用：会等当前帧传输结束（MADCTL 写命令与 QSPI 像素流不能交叠），
 * 因此仅在启动时（还没有任何帧在飞）调用。运行中改方向请用下面的请求接口。
 * 返回真正生效的角度（MADCTL 写失败时保持原方向）。必须持有 LVGL 锁。 */
int Lvgl_SetDisplayRotation(int degrees);

/* 请求改方向：只记下目标角度，真正的 MADCTL 写、lv_display_set_rotation() 和
 * 整屏重绘由 Lvgl_PortInit() 注册的 LVGL 定时器在随后的 tick 里完成。这样
 * 绝不会在 QSPI 像素传输进行中改面板寄存器（那是"画面割裂/白屏"的来源），
 * 也不会在触摸事件派发过程中动显示对象树。必须持有 LVGL 锁。
 * 返回请求的目标角度（0/90/180/270）；MADCTL 写失败时保持原方向，以
 * Lvgl_GetDisplayRotation() 为准。 */
int Lvgl_RequestDisplayRotation(int degrees);

/* 最近一次真正写进面板的方向。 */
int Lvgl_GetDisplayRotation(void);

#ifdef __cplusplus
}
#endif
