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
 * after the host sets a new time over USB. */
void app_ui_refresh_clock(void);
