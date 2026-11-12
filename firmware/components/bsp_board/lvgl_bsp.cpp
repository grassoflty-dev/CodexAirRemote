#include <stdio.h>
#include <string.h>
#include <freertos/FreeRTOS.h>
#include <esp_heap_caps.h>
#include <esp_log.h>
#include <esp_timer.h>
#include "lvgl_bsp.h"
#include <esp_lcd_touch.h>
#include "esp_lv_adapter.h"
#include "user_config.h"

static const char *TAG = "lvgl_bsp";

static lv_display_t *disp = NULL;

/*
 * Screen rotation lives in the display flush path, not in the panel driver.
 *
 * Facts (verified in this repo's managed_components):
 *  - LVGL 9.6 only renders a display rotation through its matrix transform:
 *    the rotation block in src/core/lv_refr.c:1001-1058 is inside
 *    `#if LV_DRAW_TRANSFORM_USE_MATRIX`, and the flush callback then receives
 *    already rotated areas (lv_refr.c:1446-1481).
 *  - lv_display_set_matrix_rotation() refuses to enable it unless the display
 *    renders in DIRECT or FULL mode (src/display/lv_display.c, "Unsupported
 *    rendering mode"). This panel is registered by esp_lv_adapter in PARTIAL
 *    mode with a 12 row draw buffer (see Lvgl_PortInit below), and a
 *    480x480x2 byte framebuffer for DIRECT/FULL would need 450 KiB that the
 *    ESP32-C6 does not have.
 *  - The panel driver cannot rotate either: esp_lcd_sh8601.c:311 rejects
 *    mirror_y and :320-322 rejects swap_xy, and the adapter says so itself
 *    (display_manager.c:582).
 *
 * So: LVGL keeps drawing the UI in logical (unrotated) coordinates and
 * lv_display_set_rotation() is still set, which makes LVGL's own input device
 * transform touch points (src/indev/lv_indev.c:763-768 calls
 * lv_display_rotate_point_ccw()/lv_display_rotate_point()). Every flushed band
 * is then rotated and transposed here into a scratch buffer before it is
 * handed to the adapter's original flush callback, using exactly the pixel
 * mapping of LVGL's matrix path (lv_refr.c:1002-1058), i.e. the inverse of
 * lv_display_rotate_point(): 90 deg maps (x,y) -> (y, ver_res-1-x). Touch and
 * pixels therefore always agree, on both the normal page and the standby page,
 * because this sits below the whole widget tree.
 *
 * Cost: one 16-bit transpose of every flushed band plus one extra copy into
 * the scratch buffer (the draw buffer itself is ~1/40 of the screen, so this
 * is a per-band cost, not a full-screen one).
 */

static lv_display_flush_cb_t adapter_flush_cb; /* the adapter's own flush */
static int display_rotation;                   /* 0/90/180/270 */
static bool rotate_in_flush;                   /* true = PARTIAL mode path */
static uint8_t *rotate_buf;                    /* scratch, one draw buffer big */
static size_t rotate_buf_size;
static unsigned rotate_fallbacks;              /* bands sent through unrotated */
static bool rotate_first_logged;

/* Destination area of one flushed band for a given rotation. Pixel centres map
 * the same way as in lv_display_rotate_point(), so these areas are the inverse
 * of what the indev transform expects. The panel is square (480x480), so a
 * 90/270 step keeps the area dimensions. */
static void rotate_area(const lv_area_t *src, lv_area_t *dst, int rotation)
{
    switch (rotation) {
    case 90:
        dst->x1 = src->y1;
        dst->x2 = src->y2;
        dst->y1 = BSP_LCD_V_RES - 1 - src->x2;
        dst->y2 = BSP_LCD_V_RES - 1 - src->x1;
        break;
    case 180:
        dst->x1 = BSP_LCD_H_RES - 1 - src->x2;
        dst->x2 = BSP_LCD_H_RES - 1 - src->x1;
        dst->y1 = BSP_LCD_V_RES - 1 - src->y2;
        dst->y2 = BSP_LCD_V_RES - 1 - src->y1;
        break;
    case 270:
        dst->x1 = BSP_LCD_H_RES - 1 - src->y2;
        dst->x2 = BSP_LCD_H_RES - 1 - src->y1;
        dst->y1 = src->x1;
        dst->y2 = src->x2;
        break;
    default:
        *dst = *src;
        break;
    }
}

/* Rotate a w x h RGB565 band into dst. 16-bit units are copied verbatim, so the
 * byte order LVGL/ the adapter expects is untouched (the adapter does its own
 * rgb565_swap on the buffer it is given). */
static void rotate_pixels(const uint8_t *src, int32_t w, int32_t h, uint8_t *dst, int rotation)
{
    const uint16_t *in = (const uint16_t *)src;
    uint16_t *out = (uint16_t *)dst;

    switch (rotation) {
    case 90: { /* dst is h wide and w high: dx = y, dy = w-1-x */
        for (int32_t y = 0; y < h; y++) {
            const uint16_t *row = in + (size_t)y * (size_t)w;
            for (int32_t x = 0; x < w; x++) {
                out[(size_t)(w - 1 - x) * (size_t)h + (size_t)y] = row[x];
            }
        }
        break;
    }
    case 180: { /* dst is w wide and h high: dx = w-1-x, dy = h-1-y */
        for (int32_t y = 0; y < h; y++) {
            const uint16_t *row = in + (size_t)y * (size_t)w;
            uint16_t *line = out + (size_t)(h - 1 - y) * (size_t)w;
            for (int32_t x = 0; x < w; x++) {
                line[w - 1 - x] = row[x];
            }
        }
        break;
    }
    default: { /* 270: dst is h wide and w high: dx = h-1-y, dy = x */
        for (int32_t y = 0; y < h; y++) {
            const uint16_t *row = in + (size_t)y * (size_t)w;
            for (int32_t x = 0; x < w; x++) {
                out[(size_t)x * (size_t)h + (size_t)(h - 1 - y)] = row[x];
            }
        }
        break;
    }
    }
}

/* Interposed flush: rotate the band, then let the adapter push it to the panel.
 * The adapter's callback is the only code that knows the SPI bridge, so it is
 * always the one doing the transfer (it also calls lv_display_flush_ready() from
 * the color-trans-done ISR). LVGL runs single buffered here and waits for that
 * ready before rendering the next band, so rotate_buf cannot be reused too
 * early. */
static void rotated_flush_cb(lv_display_t *display, const lv_area_t *area, uint8_t *color_map)
{
    if (!rotate_in_flush || display_rotation == 0) {
        adapter_flush_cb(display, area, color_map);
        return;
    }

    const int32_t w = lv_area_get_width(area);
    const int32_t h = lv_area_get_height(area);
    const size_t bytes = (size_t)w * (size_t)h * 2u;

    if (rotate_buf == NULL || bytes > rotate_buf_size) {
        /* Never silently draw a half rotated frame: count it and say it once. */
        if (rotate_fallbacks++ == 0) {
            ESP_LOGE(TAG, "rotation: band %dx%d (%u B) exceeds scratch %u B, frame not rotated",
                     (int)w, (int)h, (unsigned)bytes, (unsigned)rotate_buf_size);
        }
        adapter_flush_cb(display, area, color_map);
        return;
    }

    lv_area_t dst;
    rotate_area(area, &dst, display_rotation);
    rotate_pixels(color_map, w, h, rotate_buf, display_rotation);

    if (!rotate_first_logged) {
        rotate_first_logged = true;
        ESP_LOGI(TAG, "rotation: first band %d,%d..%d,%d -> %d,%d..%d,%d (%d deg, %u B)",
                 (int)area->x1, (int)area->y1, (int)area->x2, (int)area->y2, (int)dst.x1,
                 (int)dst.y1, (int)dst.x2, (int)dst.y2, display_rotation, (unsigned)bytes);
    }

    adapter_flush_cb(display, &dst, rotate_buf);
}

static lv_display_rotation_t lvgl_rotation_of(int degrees)
{
    switch (degrees) {
    case 90:  return LV_DISPLAY_ROTATION_90;
    case 180: return LV_DISPLAY_ROTATION_180;
    case 270: return LV_DISPLAY_ROTATION_270;
    default:  return LV_DISPLAY_ROTATION_0;
    }
}

extern "C" lv_display_t *Lvgl_GetDisplay(void)
{
    return disp;
}

extern "C" int Lvgl_GetDisplayRotation(void)
{
    return display_rotation;
}

extern "C" int Lvgl_SetDisplayRotation(int degrees)
{
    if (disp == NULL) {
        ESP_LOGE(TAG, "rotation: display not ready");
        return 0;
    }

    degrees %= 360;
    if (degrees < 0) degrees += 360;
    degrees = (degrees / 90) * 90; /* snap to a supported step */

    if (degrees != 0 && rotate_in_flush && rotate_buf == NULL) {
        /* Lazy: an untouched rotation setting costs no RAM. One draw buffer is
         * the largest band LVGL can flush in PARTIAL mode. */
        size_t bytes = lv_display_get_draw_buf_size(disp);
        rotate_buf = (uint8_t *)heap_caps_malloc(bytes, MALLOC_CAP_8BIT);
        if (rotate_buf == NULL) {
            ESP_LOGE(TAG, "rotation: scratch %u B alloc FAILED, free %u largest %u",
                     (unsigned)bytes,
                     (unsigned)heap_caps_get_free_size(MALLOC_CAP_8BIT),
                     (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_8BIT));
            degrees = 0;
        } else {
            rotate_buf_size = bytes;
            ESP_LOGI(TAG, "rotation: scratch %u B allocated, free %u", (unsigned)bytes,
                     (unsigned)heap_caps_get_free_size(MALLOC_CAP_8BIT));
        }
    }

    display_rotation = degrees;

    if (!rotate_in_flush) {
        /* DIRECT/FULL: LVGL can do it on its own (matrix transform). */
#if LV_DRAW_TRANSFORM_USE_MATRIX
        lv_display_set_matrix_rotation(disp, true);
#else
        ESP_LOGW(TAG, "rotation: matrix transform not enabled, DIRECT mode rotation unavailable");
#endif
    }
    lv_display_set_rotation(disp, lvgl_rotation_of(degrees));

    /* The whole tree has to be repainted: the old pixels are rotated the wrong
     * way, and a partial redraw would leave them on the panel. */
    lv_obj_invalidate(lv_display_get_screen_active(disp));

    ESP_LOGI(TAG, "rotation -> %d deg via %s, scratch %u B, %u bands sent unrotated",
             display_rotation, rotate_in_flush ? "flush transpose" : "lvgl matrix",
             (unsigned)rotate_buf_size, rotate_fallbacks);

    return display_rotation;
}

esp_err_t Lvgl_lock(int timeout_ms)
{
  	return esp_lv_adapter_lock(timeout_ms);      
}

void Lvgl_unlock(void)
{
  	esp_lv_adapter_unlock();
}

#if LVGL_VERSION_MAJOR >= 9
static void rounder_event_cb(lv_event_t *e)
{
    lv_area_t *area = (lv_area_t *)lv_event_get_param(e);
    uint16_t x1 = area->x1;
    uint16_t x2 = area->x2;

    uint16_t y1 = area->y1;
    uint16_t y2 = area->y2;

    // round the start of coordinate down to the nearest 2M number
    area->x1 = (x1 >> 1) << 1;
    area->y1 = (y1 >> 1) << 1;
    // round the end of coordinate up to the nearest 2N+1 number
    area->x2 = ((x2 >> 1) << 1) + 1;
    area->y2 = ((y2 >> 1) << 1) + 1;
}
#else
static void bsp_lvgl_rounder_cb(lv_disp_drv_t *disp_drv, lv_area_t *area)
{
    uint16_t x1 = area->x1;
    uint16_t x2 = area->x2;

    uint16_t y1 = area->y1;
    uint16_t y2 = area->y2;

    // round the start of coordinate down to the nearest 2M number
    area->x1 = (x1 >> 1) << 1;
    area->y1 = (y1 >> 1) << 1;
    // round the end of coordinate up to the nearest 2N+1 number
    area->x2 = ((x2 >> 1) << 1) + 1;
    area->y2 = ((y2 >> 1) << 1) + 1;
}
#endif

void Lvgl_PortInit(DisplayPort &display) {
    esp_lv_adapter_config_t cfg = ESP_LV_ADAPTER_DEFAULT_CONFIG();
    /* ESP32-C6 has a single core and no PSRAM: keep the LVGL task lean. */
    cfg.task_stack_size = 20 * 1024;
    cfg.task_priority = 8;
    cfg.task_core_id = 0;
    cfg.stack_in_psram = false;

    ESP_ERROR_CHECK(esp_lv_adapter_init(&cfg));
    esp_lcd_panel_handle_t panel_handle = display.Get_PanelHandle();
    esp_lcd_panel_io_handle_t io_handle = display.Get_IoHandle();
    esp_lv_adapter_display_config_t disp_cfg = ESP_LV_ADAPTER_DISPLAY_SPI_WITHOUT_PSRAM_DEFAULT_CONFIG(
        panel_handle,
        io_handle,
        BSP_LCD_H_RES,
        BSP_LCD_V_RES,
        ESP_LV_ADAPTER_ROTATE_0
    );
    /* 480 x 8 x 2 bytes = 7.5 KiB draw buffer, single buffered. */
    disp_cfg.profile.buffer_height = 12;
	
	disp = esp_lv_adapter_register_display(&disp_cfg);
    assert(disp != NULL);
#if LVGL_VERSION_MAJOR >= 9
    lv_display_add_event_cb(disp, rounder_event_cb, LV_EVENT_INVALIDATE_AREA, NULL);

    /* Keep the adapter's flush callback and put the rotation in front of it:
     * the adapter's bridge is the only place that talks to the panel (and that
     * reports the transfer back to LVGL). */
    adapter_flush_cb = lv_display_get_flush_cb(disp);
    lv_display_render_mode_t render_mode = lv_display_get_render_mode(disp);
    rotate_in_flush = (render_mode == LV_DISPLAY_RENDER_MODE_PARTIAL);
    assert(adapter_flush_cb != NULL);
    lv_display_set_flush_cb(disp, rotated_flush_cb);
    ESP_LOGI(TAG, "display: %dx%d, render mode %d, draw buf %u B, rotation via %s",
             (int)BSP_LCD_H_RES, (int)BSP_LCD_V_RES, (int)render_mode,
             (unsigned)lv_display_get_draw_buf_size(disp),
             rotate_in_flush ? "flush transpose" : "lvgl matrix");
#else
    lv_disp_t *disp_v8 = (lv_disp_t *)disp;
    if (disp_v8 && disp_v8->driver) {
        disp_v8->driver->rounder_cb = bsp_lvgl_rounder_cb;
    }
#endif

    if(display.Get_TouchInitialized()) {
        esp_lcd_touch_handle_t touch_handle = display.Get_TouchHandle();
        esp_lv_adapter_touch_config_t touch_cfg = ESP_LV_ADAPTER_TOUCH_DEFAULT_CONFIG(disp, touch_handle);
        lv_indev_t *touch = esp_lv_adapter_register_touch(&touch_cfg);
        assert(touch != NULL);
    }

	ESP_ERROR_CHECK(esp_lv_adapter_start());
}

void Lvgl_Refresh(void) {
    esp_lv_adapter_refresh_now(disp);
}
