#pragma once

#include <stdbool.h>
#include "lvgl.h"

/* Create the UI on the given display. Returns false if the board lock
 * could not be taken. */
bool app_ui_init(lv_display_t *display);

/* Capabilities reported by main before app_ui_init(); they gate the
 * on-screen actions. */
void app_ui_set_capabilities(bool mouse_ready, bool ble_ready, bool voice_ready);

/* Ask the next render tick (<= 125 ms) to repaint the clock label, used right
 * after the host sets a new time over USB. Also counts as activity, so a
 * freshly synced clock is never hidden by a standby switch. */
void app_ui_refresh_clock(void);

/* Temporary test hook: a script cannot press the panel, so the USB console
 * (AR1S/AR1S TAP) injects the same input-device press a finger produces.
 * Set to 0 to compile the console side out. */
/* TODO(发布前): 改成 0 —— 该宏会编入 AR1S / AR1S TAP / AR1B GYRO|VOICE 三个临时调试命令。 */
#define APP_UI_STANDBY_TEST_HOOK 1

/* True while the black standby page with the big clock is showing. */
bool app_ui_standby_active(void);

/* Unified RAM brightness, percent in 5..100 (default 60). One value for the
 * normal page AND the standby page: entering/leaving standby no longer changes
 * it. RAM only, never written to NVS. app_ui_set_brightness() applies it to the
 * panel immediately (only writing when the value really changed). Must be
 * called with the LVGL lock held. */
int app_ui_brightness(void);
void app_ui_set_brightness(int percent);

/* Restart the 60 s idle countdown. Any UI interaction calls it; the settings
 * panel calls it for its own widgets. */
void app_ui_note_activity(void);

/* 立即进入待机页（侧边第三键短按、以及任何需要强制息屏的调用方）。
 * 可从任意任务调用：先安全停掉占用方（陀螺仪鼠标、语音会话）并等 app_busy
 * 真正释放，再由渲染 tick 在 LVGL 上下文里切页；已处于待机时则改为唤醒。
 * 不会绕过 AXP2101 的电源键长按关机。 */
void app_ui_standby_now(void);

/* Ask the standby page to treat a tap as done (consumed by render()). */
void app_ui_standby_tap(void);

/* Ask the next render tick to play the click one of the four buttons would get
 * from a finger: 'g' = Gyro, 'v' = Voice. Consumed by render(); part of the
 * same test hook as app_ui_standby_tap(). */
void app_ui_debug_click(char which);
