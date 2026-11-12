/*
 * "Function settings" panel: a full screen page that drops in from the top of
 * the normal page (top swipe) and leaves with a bottom-up swipe (phone style),
 * a close button, or a tap on empty space.
 *
 * Layout (480 x 480 panel):
 *   - title + close button on top
 *   - ROTATE button on the left (90 degrees counter-clockwise per press)
 *   - brightness hot area on the right: x 300..456, y 90..410. The whole
 *     156 x 320 rectangle is the hit area; a 40 px wide track is drawn inside
 *     and the value follows the finger's ABSOLUTE y, so no incremental drift.
 *   - bottom hint "swipe up to close"; the close swipe starts at y >= 420 so it
 *     can never fight with the brightness area (which ends at y 410).
 *
 * The widgets are built lazily on the first open and then reused: the normal
 * page stays as light as before for the LVGL pool, which matters because the
 * standby page is built from the same 22 KiB pool.
 *
 * Both settings are RAM only: the brightness lives in app_ui.c (one value for
 * normal page and standby page) and the rotation in the BSP display code.
 * Nothing here reads or writes NVS.
 */
#include "settings_panel.h"

#include <stdbool.h>
#include <stdio.h>

#include "app_busy.h"
#include "app_ui.h"
#include "board.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "lvgl.h"

static const char *TAG = "settings";

#define PANEL_W 480
#define PANEL_H 480

/* Brightness hot area (the whole rectangle reacts) and the visual track. */
#define BRIGHT_X1 300
#define BRIGHT_Y1 90
#define BRIGHT_X2 456
#define BRIGHT_Y2 410
#define TRACK_X1 358
#define TRACK_X2 398
#define TRACK_Y1 100
#define TRACK_Y2 400
#define KNOB_SIZE 44

#define BRIGHT_MIN 5
#define BRIGHT_MAX 100
#define BRIGHT_STEP 5

/* Gestures. */
#define SWIPE_TOP_ZONE 70
#define OPEN_MIN_DY 60
#define CLOSE_ZONE_Y 420
#define CLOSE_MIN_DY 70

#define PANEL_BG 0x0b0f14
#define PANEL_TRACK 0x22303f
#define PANEL_ACCENT 0x4f8cff
#define PANEL_MUTED 0x8a97a8

static lv_obj_t *overlay;
static lv_obj_t *bright_hot;
static lv_obj_t *bright_track;
static lv_obj_t *bright_knob;
static lv_obj_t *bright_value;
static lv_obj_t *rotate_label;

static lv_indev_t *touch_indev;
static lv_obj_t *panel_screen;

static bool panel_open;
static bool panel_built;

static bool swipe_tracking;
static lv_point_t swipe_start;
static bool close_tracking;

static int clamp_brightness(int value)
{
    if (value < BRIGHT_MIN) value = BRIGHT_MIN;
    if (value > BRIGHT_MAX) value = BRIGHT_MAX;
    return value;
}

/* Nearest 5 % to the finger's absolute y inside the track; the value is
 * written as-is (no snap back to a previous value on release). */
static int brightness_from_y(int32_t y)
{
    if (y <= TRACK_Y1) return BRIGHT_MAX;
    if (y >= TRACK_Y2) return BRIGHT_MIN;

    int32_t span = TRACK_Y2 - TRACK_Y1;
    int32_t from_top = y - TRACK_Y1;
    int value = BRIGHT_MAX - (int)((from_top * (BRIGHT_MAX - BRIGHT_MIN) + span / 2) / span);
    value = clamp_brightness(value);
    return ((value + BRIGHT_STEP / 2) / BRIGHT_STEP) * BRIGHT_STEP;
}

static void brightness_refresh_widgets(void)
{
    int value = app_ui_brightness();

    if (bright_value != NULL) {
        lv_label_set_text_fmt(bright_value, "%d%%", value);
    }
    if (bright_knob != NULL) {
        int32_t span = TRACK_Y2 - TRACK_Y1;
        int32_t offset = ((BRIGHT_MAX - value) * span) / (BRIGHT_MAX - BRIGHT_MIN);
        lv_obj_set_pos(bright_knob, (TRACK_X1 + TRACK_X2) / 2 - KNOB_SIZE / 2,
                       TRACK_Y1 + offset - KNOB_SIZE / 2);
    }
}

static void apply_brightness_from_point(const lv_point_t *point)
{
    int value = brightness_from_y(point->y);
    if (value == app_ui_brightness()) return;

    app_ui_set_brightness(value);
    brightness_refresh_widgets();
    ESP_LOGI(TAG, "settings: slider y=%d -> %d%%", (int)point->y, value);
}

static void bright_event_cb(lv_event_t *event)
{
    lv_event_code_t code = lv_event_get_code(event);
    if (code != LV_EVENT_PRESSED && code != LV_EVENT_PRESSING && code != LV_EVENT_RELEASED) {
        return;
    }
    if (touch_indev == NULL) return;

    lv_point_t point;
    lv_indev_get_point(touch_indev, &point);
    if (code == LV_EVENT_RELEASED) {
        brightness_refresh_widgets();
        app_ui_note_activity();
        return;
    }
    apply_brightness_from_point(&point);
    app_ui_note_activity();
}

static void overlay_clicked_cb(lv_event_t *event)
{
    /* Only fires when the overlay itself is the target: presses on the sheet
     * widgets have their own targets, so dragging the brightness area can
     * never close the panel this way. */
    if (lv_event_get_target(event) == overlay) settings_panel_close();
}

static void close_clicked_cb(lv_event_t *event)
{
    (void)event;
    settings_panel_close();
}

static void rotate_clicked_cb(lv_event_t *event)
{
    (void)event;
    int next = (board_display_rotation() + 90) % 360; /* 90 deg CCW per press */
    int applied = board_display_rotation_set(next);

    if (rotate_label != NULL) lv_label_set_text_fmt(rotate_label, "%d deg", applied);
    ESP_LOGI(TAG, "settings: rotation -> %d", applied);
}

static lv_obj_t *panel_label(lv_obj_t *parent, const char *text, const lv_font_t *font,
                             uint32_t color, int32_t x, int32_t y)
{
    lv_obj_t *label = lv_label_create(parent);
    lv_label_set_text(label, text);
    lv_obj_set_style_text_font(label, font, 0);
    lv_obj_set_style_text_color(label, lv_color_hex(color), 0);
    lv_obj_set_pos(label, x, y);
    return label;
}

/* Build once on the first open; the widgets stay allocated afterwards. */
static void panel_build(void)
{
    if (panel_built || panel_screen == NULL) return;

    overlay = lv_obj_create(panel_screen);
    lv_obj_remove_style_all(overlay);
    lv_obj_set_size(overlay, PANEL_W, PANEL_H);
    lv_obj_set_pos(overlay, 0, 0);
    lv_obj_set_style_bg_color(overlay, lv_color_hex(PANEL_BG), 0);
    lv_obj_set_style_bg_opa(overlay, LV_OPA_COVER, 0); /* opaque: nothing bleeds through */
    lv_obj_set_style_border_width(overlay, 0, 0);
    lv_obj_set_style_radius(overlay, 0, 0);
    lv_obj_set_style_pad_all(overlay, 0, 0);
    lv_obj_set_scrollable(overlay, false);
    lv_obj_set_clickable(overlay, true);
    lv_obj_add_event_cb(overlay, overlay_clicked_cb, LV_EVENT_CLICKED, NULL);

    panel_label(overlay, "Function settings", &lv_font_montserrat_28, 0xffffff, 24, 18);

    lv_obj_t *close = lv_button_create(overlay);
    lv_obj_set_size(close, 56, 56);
    lv_obj_set_pos(close, PANEL_W - 56 - 20, 14);
    lv_obj_set_style_radius(close, 18, 0);
    lv_obj_set_style_bg_color(close, lv_color_hex(0x1b2430), 0);
    lv_obj_set_style_bg_color(close, lv_color_hex(0x2b3543), LV_STATE_PRESSED);
    lv_obj_set_style_shadow_width(close, 0, 0);
    lv_obj_add_event_cb(close, close_clicked_cb, LV_EVENT_SHORT_CLICKED, NULL);
    lv_obj_t *close_label = lv_label_create(close);
    lv_label_set_text(close_label, LV_SYMBOL_CLOSE);
    lv_obj_set_style_text_font(close_label, &lv_font_montserrat_28, 0);
    lv_obj_set_style_text_color(close_label, lv_color_white(), 0);
    lv_obj_center(close_label);

    lv_obj_t *rotate = lv_button_create(overlay);
    lv_obj_set_size(rotate, 150, 96);
    lv_obj_set_pos(rotate, 24, 120);
    lv_obj_set_style_radius(rotate, 18, 0);
    lv_obj_set_style_bg_color(rotate, lv_color_hex(0x182638), 0);
    lv_obj_set_style_bg_color(rotate, lv_color_hex(0x405777), LV_STATE_PRESSED);
    lv_obj_set_style_shadow_width(rotate, 0, 0);
    lv_obj_add_event_cb(rotate, rotate_clicked_cb, LV_EVENT_SHORT_CLICKED, NULL);
    lv_obj_t *rotate_title = lv_label_create(rotate);
    lv_label_set_text(rotate_title, "ROTATE");
    lv_obj_set_style_text_font(rotate_title, &lv_font_montserrat_20, 0);
    lv_obj_set_style_text_color(rotate_title, lv_color_white(), 0);
    lv_obj_align(rotate_title, LV_ALIGN_TOP_MID, 0, 18);
    rotate_label = lv_label_create(rotate);
    lv_label_set_text(rotate_label, "0 deg");
    lv_obj_set_style_text_font(rotate_label, &lv_font_montserrat_20, 0);
    lv_obj_set_style_text_color(rotate_label, lv_color_hex(PANEL_MUTED), 0);
    lv_obj_align(rotate_label, LV_ALIGN_BOTTOM_MID, 0, -16);

    panel_label(overlay, "Brightness", &lv_font_montserrat_20, PANEL_MUTED, BRIGHT_X1, 52);
    bright_value = panel_label(overlay, "60%", &lv_font_montserrat_28, 0xffffff, BRIGHT_X1 + 96, 44);

    /* Track (visual only) and knob. */
    bright_track = lv_obj_create(overlay);
    lv_obj_remove_style_all(bright_track);
    lv_obj_set_size(bright_track, TRACK_X2 - TRACK_X1, TRACK_Y2 - TRACK_Y1);
    lv_obj_set_pos(bright_track, TRACK_X1, TRACK_Y1);
    lv_obj_set_style_bg_color(bright_track, lv_color_hex(PANEL_TRACK), 0);
    lv_obj_set_style_bg_opa(bright_track, LV_OPA_COVER, 0);
    lv_obj_set_style_radius(bright_track, (TRACK_X2 - TRACK_X1) / 2, 0);
    lv_obj_set_style_border_width(bright_track, 0, 0);
    lv_obj_set_style_pad_all(bright_track, 0, 0);
    lv_obj_clear_flag(bright_track, LV_OBJ_FLAG_CLICKABLE);

    bright_knob = lv_obj_create(overlay);
    lv_obj_remove_style_all(bright_knob);
    lv_obj_set_size(bright_knob, KNOB_SIZE, KNOB_SIZE);
    lv_obj_set_style_radius(bright_knob, LV_RADIUS_CIRCLE, 0);
    lv_obj_set_style_bg_color(bright_knob, lv_color_hex(PANEL_ACCENT), 0);
    lv_obj_set_style_bg_opa(bright_knob, LV_OPA_COVER, 0);
    lv_obj_set_style_border_width(bright_knob, 0, 0);
    lv_obj_clear_flag(bright_knob, LV_OBJ_FLAG_CLICKABLE);

    /* Wide, transparent hit area above the track: this is what the finger
     * actually hits, so the slider never depends on a 26 px widget. */
    bright_hot = lv_obj_create(overlay);
    lv_obj_remove_style_all(bright_hot);
    lv_obj_set_size(bright_hot, BRIGHT_X2 - BRIGHT_X1, BRIGHT_Y2 - BRIGHT_Y1);
    lv_obj_set_pos(bright_hot, BRIGHT_X1, BRIGHT_Y1);
    lv_obj_set_style_bg_opa(bright_hot, LV_OPA_TRANSP, 0);
    lv_obj_set_style_border_width(bright_hot, 0, 0);
    lv_obj_set_style_pad_all(bright_hot, 0, 0);
    lv_obj_set_scrollable(bright_hot, false);
    lv_obj_set_clickable(bright_hot, true);
    lv_obj_add_event_cb(bright_hot, bright_event_cb, LV_EVENT_PRESSED, NULL);
    lv_obj_add_event_cb(bright_hot, bright_event_cb, LV_EVENT_PRESSING, NULL);
    lv_obj_add_event_cb(bright_hot, bright_event_cb, LV_EVENT_RELEASED, NULL);

    panel_label(overlay, "swipe up from the bottom to close", &lv_font_montserrat_20,
               0x55606e, 24, PANEL_H - 40);

    lv_obj_set_hidden(overlay, true);
    brightness_refresh_widgets();
    panel_built = true;

    lv_mem_monitor_t mon;
    lv_mem_monitor(&mon);
    ESP_LOGI(TAG, "settings: panel built, lvgl free %u biggest %u", (unsigned)mon.free_size,
             (unsigned)mon.free_biggest_size);
}

static void panel_show(bool show)
{
    if (overlay == NULL) return;
    if (show) lv_obj_move_to_index(overlay, -1);
    lv_obj_set_hidden(overlay, !show);
}

/* Indev level: sees every touch. Two jobs: open the panel from the top of the
 * normal page, close it with a bottom-up swipe. */
static void panel_touch_cb(lv_event_t *event)
{
    lv_event_code_t code = lv_event_get_code(event);
    lv_point_t now;

    if (touch_indev == NULL) return;

    if (!panel_open) {
        /* Never on the standby page: it owns the touch for its wake tap. */
        if (app_ui_standby_active()) {
            swipe_tracking = false;
            return;
        }
        switch (code) {
        case LV_EVENT_PRESSED:
            lv_indev_get_point(touch_indev, &swipe_start);
            swipe_tracking = swipe_start.y < SWIPE_TOP_ZONE;
            break;
        case LV_EVENT_GESTURE:
        case LV_EVENT_RELEASED: {
            if (!swipe_tracking) break;
            if (code == LV_EVENT_GESTURE &&
                lv_indev_get_gesture_dir(touch_indev) != LV_DIR_BOTTOM) {
                break; /* wait for the release */
            }
            lv_indev_get_point(touch_indev, &now);
            int dy = now.y - swipe_start.y;
            int dx = now.x - swipe_start.x;
            int adx = dx < 0 ? -dx : dx;
            int ady = dy < 0 ? -dy : dy;
            if (dy >= OPEN_MIN_DY && ady > adx * 2) {
                swipe_tracking = false;
                settings_panel_open();
            } else if (code == LV_EVENT_RELEASED) {
                swipe_tracking = false;
            }
            break;
        }
        case LV_EVENT_PRESS_LOST:
        case LV_EVENT_CLICKED:
            swipe_tracking = false;
            break;
        default:
            break;
        }
        return;
    }

    /* Panel is open: bottom-up swipe closes it. The brightness area wins any
     * overlap, so a press inside it is never treated as a close swipe. */
    switch (code) {
    case LV_EVENT_PRESSED: {
        lv_indev_get_point(touch_indev, &swipe_start);
        bool in_bright = swipe_start.x >= BRIGHT_X1 && swipe_start.x < BRIGHT_X2 &&
                         swipe_start.y >= BRIGHT_Y1 && swipe_start.y < BRIGHT_Y2;
        close_tracking = swipe_start.y >= CLOSE_ZONE_Y && !in_bright;
        break;
    }
    case LV_EVENT_GESTURE:
    case LV_EVENT_RELEASED: {
        if (!close_tracking) break;
        if (code == LV_EVENT_GESTURE &&
            lv_indev_get_gesture_dir(touch_indev) != LV_DIR_TOP) {
            break;
        }
        lv_indev_get_point(touch_indev, &now);
        int dy = now.y - swipe_start.y;
        int dx = now.x - swipe_start.x;
        int adx = dx < 0 ? -dx : dx;
        int ady = dy < 0 ? -dy : dy;
        if (dy <= -CLOSE_MIN_DY && ady > adx * 2) {
            close_tracking = false;
            settings_panel_close();
        } else if (code == LV_EVENT_RELEASED) {
            close_tracking = false;
        }
        break;
    }
    default:
        break;
    }
}

void settings_panel_init(lv_obj_t *screen, lv_display_t *display, lv_indev_t *indev)
{
    (void)display;
    panel_screen = screen;
    touch_indev = indev;
    panel_open = false;
    panel_built = false;

    if (touch_indev != NULL) {
        lv_indev_add_event_cb(touch_indev, panel_touch_cb, LV_EVENT_ALL, NULL);
    } else {
        ESP_LOGW(TAG, "settings: no touch input, gestures disabled");
    }

    ESP_LOGI(TAG, "settings: panel ready (lazy build), swipe down from the top %d px",
             SWIPE_TOP_ZONE);
}

bool settings_panel_is_open(void)
{
    return panel_open;
}

void settings_panel_open(void)
{
    if (panel_open) return;
    if (app_ui_standby_active()) return; /* standby page owns the screen */

    panel_build();
    if (overlay == NULL) return;

    panel_open = true;
    swipe_tracking = false;
    close_tracking = false;

    brightness_refresh_widgets();
    panel_show(true);

    app_busy_acquire(APP_BUSY_SETTINGS);
    app_ui_note_activity();
    ESP_LOGI(TAG, "settings: panel open, brightness %d, rotation %d, busy 0x%x",
             app_ui_brightness(), board_display_rotation(), app_busy_mask());
}

void settings_panel_close(void)
{
    if (!panel_open) return;

    panel_open = false;
    swipe_tracking = false;
    close_tracking = false;
    panel_show(false);
    app_busy_release(APP_BUSY_SETTINGS);
    app_ui_note_activity();
    ESP_LOGI(TAG, "settings: panel close, brightness %d, rotation %d, busy 0x%x",
             app_ui_brightness(), board_display_rotation(), app_busy_mask());
}
