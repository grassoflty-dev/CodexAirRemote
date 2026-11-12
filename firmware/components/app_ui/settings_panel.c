/* Function settings panel: brightness slider + rotate button, opened by a
 * downward swipe from the top edge of the normal page.
 *
 * Layout (480 x 480): a full screen semi transparent overlay with a 250 px sheet
 * on top. Right side: vertical brightness slider (5..100 %, step 5). Left side:
 * the rotate button. Tapping the overlay outside the sheet closes it.
 *
 * State is RAM only. Brightness is the shared ui_brightness in app_ui.c (the
 * standby page uses the same value) and rotation is the display level rotation
 * owned by bsp_board; neither is ever written to NVS.
 */
#include "settings_panel.h"

#include <stdio.h>
#include <string.h>

#include "app_busy.h"
#include "app_ui.h"
#include "board.h"
#include "esp_log.h"

static const char *TAG = "settings";

/* Swipe gesture: start inside the top hot zone, move down at least 60 px with a
 * clear vertical direction (2:1 slop) so a horizontal drag or a slightly slanted
 * tap never opens the panel. Coordinates are LVGL logical coordinates, i.e. the
 * same ones the user sees, also after a screen rotation (LVGL transforms the
 * touch point for the display rotation before it reaches us). */
#define SWIPE_TOP_ZONE 70
#define SWIPE_MIN_DY 60

#define PANEL_BRIGHT_MIN 5
#define PANEL_BRIGHT_MAX 100
#define PANEL_BRIGHT_STEP 5

#define PANEL_SHEET_H 250
#define PANEL_BG 0x101a26
#define PANEL_ACCENT 0x2f8fae
#define PANEL_MUTED 0x8fa3b8

static lv_obj_t *overlay;
static lv_obj_t *sheet;
static lv_obj_t *bright_slider;
static lv_obj_t *bright_value;
static lv_indev_t *touch_indev;

static bool panel_open;
static bool swipe_tracking;
/* Set while the code itself moves the slider, so the resulting VALUE_CHANGED
 * event is not echoed back into app_ui_set_brightness(). */
static bool slider_snapping;
static lv_point_t swipe_start;

/* Only write the backlight when the stepped value really changed: dragging
 * across one slider pixel must not re-program the panel over and over. */
static void brightness_apply_from_slider(void)
{
    int value = (int)lv_slider_get_value(bright_slider);
    int stepped = ((value + PANEL_BRIGHT_STEP / 2) / PANEL_BRIGHT_STEP) * PANEL_BRIGHT_STEP;

    if (stepped < PANEL_BRIGHT_MIN) stepped = PANEL_BRIGHT_MIN;
    if (stepped > PANEL_BRIGHT_MAX) stepped = PANEL_BRIGHT_MAX;
    if (stepped == app_ui_brightness()) return;

    ESP_LOGI(TAG, "settings: brightness %d -> %d", app_ui_brightness(), stepped);
    app_ui_set_brightness(stepped);
    lv_label_set_text_fmt(bright_value, "%d%%", stepped);
}

static void brightness_changed_cb(lv_event_t *event)
{
    if (slider_snapping) return;
    brightness_apply_from_slider();
    app_ui_note_activity();
}

/* Snap the knob onto the stored 5 % step once the finger lifts, so the slider
 * and the backlight never disagree by a few percent. */
static void brightness_released_cb(lv_event_t *event)
{
    if (slider_snapping) return;
    slider_snapping = true;
    lv_slider_set_value(bright_slider, app_ui_brightness(), LV_ANIM_OFF);
    slider_snapping = false;
    lv_label_set_text_fmt(bright_value, "%d%%", app_ui_brightness());
    app_ui_note_activity();
}

static void rotate_clicked_cb(lv_event_t *event)
{
    /* One press = 90 degrees counter-clockwise on the panel: LV_DISPLAY_ROTATION_90
     * is the orientation whose pixel mapping turns the content 90 degrees
     * counter-clockwise (lv_refr.c:1002-1058), and 4 presses are back to 0. */
    int next = (board_display_rotation() + 90) % 360;
    int applied = board_display_rotation_set(next);

    ESP_LOGI(TAG, "settings: rotation -> %d", applied);
    app_ui_note_activity();
}

static void overlay_clicked_cb(lv_event_t *event)
{
    /* Only fires when the overlay itself (i.e. the dark area outside the sheet)
     * is the click target: presses on the sheet, slider or button hit their own
     * object, so dragging the slider can never close the panel. */
    settings_panel_close();
}

static bool swipe_is_downward(const lv_point_t *now)
{
    int dy = now->y - swipe_start.y;
    int dx = now->x - swipe_start.x;
    int adx = dx < 0 ? -dx : dx;
    int ady = dy < 0 ? -dy : dy;

    return dy >= SWIPE_MIN_DY && ady > adx * 2;
}

/* Indev level callback: sees every touch whichever object it hits, which is what
 * a gesture that starts on the (non clickable) clock labels needs.
 *
 * Note on the event set: LVGL forwards a pointer event to the input device only
 * for PRESSED / RELEASED / CLICKED / SHORT_CLICKED / LONG_PRESSED... (see
 * send_event() in lv_indev.c), NOT for PRESSING, and a swipe is reported as
 * LV_EVENT_GESTURE on the indev (lv_indev.c:1902). So the panel opens either
 * when LVGL recognises a downward gesture or, for slower drags, on release -
 * both paths go through swipe_is_downward(), which enforces the start zone, the
 * 60 px distance and the vertical direction. */
static void panel_touch_cb(lv_event_t *event)
{
    lv_event_code_t code = lv_event_get_code(event);
    lv_point_t now;

    /* Never while the panel is up (dragging the slider must not re-open it) and
     * never on the standby page: that page owns the touch for its wake tap. */
    if (panel_open || app_ui_standby_active()) {
        swipe_tracking = false;
        return;
    }

    switch (code) {
    case LV_EVENT_PRESSED:
        lv_indev_get_point(touch_indev, &swipe_start);
        swipe_tracking = swipe_start.y < SWIPE_TOP_ZONE;
        break;
    case LV_EVENT_GESTURE:
    case LV_EVENT_RELEASED:
        if (!swipe_tracking) break;
        if (code == LV_EVENT_GESTURE && lv_indev_get_gesture_dir(touch_indev) != LV_DIR_BOTTOM) {
            break; /* horizontal (or any other) gesture: wait for the release */
        }
        lv_indev_get_point(touch_indev, &now);
        if (swipe_is_downward(&now)) {
            swipe_tracking = false;
            settings_panel_open();
        } else if (code == LV_EVENT_RELEASED) {
            /* A tap or a mostly horizontal drag: not a downward swipe. */
            swipe_tracking = false;
        }
        break;
    case LV_EVENT_PRESS_LOST:
    case LV_EVENT_CLICKED:
        swipe_tracking = false;
        break;
    default:
        break;
    }
}

static void panel_style_sheet(lv_obj_t *obj)
{
    lv_obj_set_style_bg_color(obj, lv_color_hex(PANEL_BG), 0);
    lv_obj_set_style_bg_opa(obj, LV_OPA_COVER, 0);
    lv_obj_set_style_radius(obj, 22, 0);
    lv_obj_set_style_border_width(obj, 0, 0);
    lv_obj_set_style_shadow_width(obj, 0, 0);
    lv_obj_set_style_pad_all(obj, 0, 0);
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

void settings_panel_init(lv_obj_t *screen, lv_display_t *display, lv_indev_t *indev)
{
    (void)display;
    touch_indev = indev;

    /* Full screen blocker: dark, semi transparent, hidden until the swipe. It is
     * clickable on purpose so a tap outside the sheet lands here (and reaches no
     * button underneath) and closes the panel. */
    overlay = lv_obj_create(screen);
    lv_obj_remove_style_all(overlay);
    lv_obj_set_size(overlay, LV_PCT(100), LV_PCT(100));
    lv_obj_set_pos(overlay, 0, 0);
    lv_obj_set_style_bg_color(overlay, lv_color_black(), 0);
    lv_obj_set_style_bg_opa(overlay, LV_OPA_60, 0);
    lv_obj_set_style_border_width(overlay, 0, 0);
    lv_obj_set_style_pad_all(overlay, 0, 0);
    lv_obj_set_style_radius(overlay, 0, 0);
    lv_obj_set_scrollable(overlay, false);
    lv_obj_set_clickable(overlay, true);
    lv_obj_add_event_cb(overlay, overlay_clicked_cb, LV_EVENT_CLICKED, NULL);

    /* The sheet: 250 px tall, full width, anchored to the top edge. */
    sheet = lv_obj_create(overlay);
    panel_style_sheet(sheet);
    lv_obj_set_size(sheet, LV_PCT(100), PANEL_SHEET_H);
    lv_obj_align(sheet, LV_ALIGN_TOP_MID, 0, 0);
    lv_obj_set_scrollable(sheet, false);
    lv_obj_set_clickable(sheet, true);

    panel_label(sheet, "Function settings", &lv_font_montserrat_20, PANEL_MUTED, 24, 16);

    /* Left: one press = 90 degrees counter-clockwise. */
    lv_obj_t *rotate = lv_button_create(sheet);
    lv_obj_set_size(rotate, 150, 86);
    lv_obj_set_pos(rotate, 24, 62);
    lv_obj_set_style_radius(rotate, 18, 0);
    lv_obj_set_style_bg_color(rotate, lv_color_hex(0x182638), 0);
    lv_obj_set_style_bg_color(rotate, lv_color_hex(0x405777), LV_STATE_PRESSED);
    lv_obj_set_style_shadow_width(rotate, 0, 0);
    lv_obj_add_event_cb(rotate, rotate_clicked_cb, LV_EVENT_SHORT_CLICKED, NULL);
    lv_obj_t *rotate_label = lv_label_create(rotate);
    lv_label_set_text(rotate_label, "ROTATE");
    lv_obj_set_style_text_font(rotate_label, &lv_font_montserrat_20, 0);
    lv_obj_set_style_text_color(rotate_label, lv_color_white(), 0);
    lv_obj_align(rotate_label, LV_ALIGN_TOP_MID, 0, 16);
    lv_obj_t *rotate_hint = lv_label_create(rotate);
    lv_label_set_text(rotate_hint, "90 deg CCW");
    lv_obj_set_style_text_font(rotate_hint, &lv_font_montserrat_20, 0);
    lv_obj_set_style_text_color(rotate_hint, lv_color_hex(PANEL_MUTED), 0);
    lv_obj_align(rotate_hint, LV_ALIGN_BOTTOM_MID, 0, -14);

    panel_label(sheet, "Tap outside to close", &lv_font_montserrat_20, 0x55606e, 24, 186);

    /* Right: vertical brightness slider, 5..100 in 5 % steps. */
    panel_label(sheet, "Brightness", &lv_font_montserrat_20, PANEL_MUTED, 286, 62);

    bright_slider = lv_slider_create(sheet);
    lv_obj_set_size(bright_slider, 26, 140); /* taller than wide = vertical */
    lv_obj_set_pos(bright_slider, 318, 96);
    lv_slider_set_range(bright_slider, PANEL_BRIGHT_MIN, PANEL_BRIGHT_MAX);
    lv_slider_set_value(bright_slider, app_ui_brightness(), LV_ANIM_OFF);
    lv_obj_set_style_bg_color(bright_slider, lv_color_hex(0x22303f), LV_PART_MAIN);
    lv_obj_set_style_bg_opa(bright_slider, LV_OPA_COVER, LV_PART_MAIN);
    lv_obj_set_style_radius(bright_slider, 13, LV_PART_MAIN);
    lv_obj_set_style_bg_color(bright_slider, lv_color_hex(PANEL_ACCENT), LV_PART_INDICATOR);
    lv_obj_set_style_bg_opa(bright_slider, LV_OPA_COVER, LV_PART_INDICATOR);
    lv_obj_set_style_radius(bright_slider, 13, LV_PART_INDICATOR);
    lv_obj_set_style_bg_color(bright_slider, lv_color_white(), LV_PART_KNOB);
    lv_obj_set_style_radius(bright_slider, LV_RADIUS_CIRCLE, LV_PART_KNOB);
    lv_obj_set_style_pad_all(bright_slider, 8, LV_PART_KNOB);
    lv_obj_add_event_cb(bright_slider, brightness_changed_cb, LV_EVENT_VALUE_CHANGED, NULL);
    lv_obj_add_event_cb(bright_slider, brightness_released_cb, LV_EVENT_RELEASED, NULL);

    bright_value = lv_label_create(sheet);
    lv_label_set_text_fmt(bright_value, "%d%%", app_ui_brightness());
    lv_obj_set_style_text_font(bright_value, &lv_font_montserrat_28, 0);
    lv_obj_set_style_text_color(bright_value, lv_color_white(), 0);
    lv_obj_set_pos(bright_value, 360, 140);

    lv_obj_set_hidden(overlay, true);
    panel_open = false;

    if (touch_indev) {
        lv_indev_add_event_cb(touch_indev, panel_touch_cb, LV_EVENT_ALL, NULL);
    } else {
        ESP_LOGW(TAG, "settings: no touch input, swipe gesture disabled");
    }

    ESP_LOGI(TAG, "settings: panel ready, swipe down from the top %d px "
             "(brightness %d, rotation %d)",
             SWIPE_TOP_ZONE, app_ui_brightness(), board_display_rotation());
}

bool settings_panel_is_open(void)
{
    return panel_open;
}

void settings_panel_open(void)
{
    if (panel_open || overlay == NULL) return;
    /* The standby page owns the screen; never cover it. */
    if (app_ui_standby_active()) return;

    panel_open = true;
    swipe_tracking = false;

    slider_snapping = true;
    lv_slider_set_value(bright_slider, app_ui_brightness(), LV_ANIM_OFF);
    slider_snapping = false;
    lv_label_set_text_fmt(bright_value, "%d%%", app_ui_brightness());

    /* Above every other widget, then visible. */
    lv_obj_move_to_index(overlay, -1);
    lv_obj_set_hidden(overlay, false);

    /* Pin the idle countdown while the user edits the board; released again in
     * settings_panel_close(), which restarts the 60 s countdown. */
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
    lv_obj_set_hidden(overlay, true);
    app_busy_release(APP_BUSY_SETTINGS);
    app_ui_note_activity();
    ESP_LOGI(TAG, "settings: panel close, brightness %d, rotation %d, busy 0x%x",
             app_ui_brightness(), board_display_rotation(), app_busy_mask());
}
