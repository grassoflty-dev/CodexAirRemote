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
 * The rotation is a rotation of the *content* seen by the user: every step
 * turns the UI 90 degrees counter-clockwise (the same direction LVGL's own
 * matrix rotation produces). Touch input follows automatically because
 * lv_display_set_rotation() makes LVGL transform the indev points
 * (src/indev/lv_indev.c:763-768 -> lv_display_rotate_point()).
 *
 * Returns the rotation that is actually applied (0 when the rotation could not
 * be enabled, e.g. the scratch buffer for the flush path could not be
 * allocated). Must be called with the LVGL lock held. */
int Lvgl_SetDisplayRotation(int degrees);
int Lvgl_GetDisplayRotation(void);

#ifdef __cplusplus
}
#endif
