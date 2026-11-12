#pragma once

#include <stdbool.h>

#include "lvgl.h"

/*
 * "Function settings" panel (settings_panel.c).
 *
 * A full screen overlay with a sheet that slides in from the top. It is opened
 * by a downward swipe that starts in the top hot zone of the NORMAL page (never
 * the standby page) and it is closed by tapping outside the sheet. While it is
 * open it holds app_busy(APP_BUSY_SETTINGS), so the 60 s idle -> standby timer
 * does not run; closing it releases the hold and the countdown starts over.
 *
 * Contents: a brightness slider (5..100 %, step 5, shared with the standby page
 * through app_ui_set_brightness()) and a rotate button (90 degrees
 * counter-clockwise per press, through board_display_rotation_set()).
 *
 * Both values live in RAM only: nothing here reads or writes NVS.
 */

/* Create the panel on `screen` and hook the swipe gesture on `indev` (may be
 * NULL: the panel is then only reachable through settings_panel_open()).
 * Must be called with the LVGL lock held, before the render timer starts. */
void settings_panel_init(lv_obj_t *screen, lv_display_t *display, lv_indev_t *indev);

/* True while the panel covers the main UI. */
bool settings_panel_is_open(void);

/* Show/hide the panel. open() is a no-op while the standby page is active, so
 * the panel can never appear on top of it. Both are idempotent. */
void settings_panel_open(void);
void settings_panel_close(void);
