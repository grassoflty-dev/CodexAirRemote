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
static lv_obj_t *rotate_hint;
static lv_style_t flat_styles[5];
static bool flat_styles_ready;
static char brightness_text[5];

/* 共享纯色样式，省去重复的对象局部样式与圆角遮罩。 */
static void flat_rect(lv_obj_t *obj, unsigned index)
{
    if (!flat_styles_ready) {
        const uint32_t colors[] = {PANEL_BG, 0x1b2430, 0x182638, PANEL_TRACK, PANEL_ACCENT};
        for (unsigned i = 0; i < sizeof(colors) / sizeof(colors[0]); ++i) {
            lv_style_init(&flat_styles[i]);
            lv_style_set_bg_color(&flat_styles[i], lv_color_hex(colors[i]));
            lv_style_set_bg_opa(&flat_styles[i], LV_OPA_COVER);
        }
        flat_styles_ready = true;
    }
    lv_obj_remove_style_all(obj);
    lv_obj_add_style(obj, &flat_styles[index], 0);
}

/* 旋转与设置页 overlay 的交接：overlay 是不透明全屏（480x480），旋转时的整屏
 * 重绘会把它一起算进去，LVGL 池只剩 ~1 KB 时 lv_draw_add_task 空指针 panic
 * （2026-11-15 真机事故）。因此旋转前隐藏 overlay、按需删掉它回收内存，
 * 旋转完成/失败后再统一恢复（刷新/滑条/按钮全部重建）。 */
static bool rotation_in_progress;
static bool rotation_overlay_dropped;
static int rotation_last_result;
/* 诊断：LVGL 已完成渲染/提交刷新，不等同于面板已经扫描显示。 */
static enum { ROT_FRAME_NONE, ROT_FRAME_MAIN, ROT_FRAME_OVERLAY } rotation_frame_probe;
static lv_timer_t *rotation_begin_timer;
static lv_timer_t *rotation_restore_timer;
static lv_timer_t *rotation_safety_timer;

static void rotation_begin_cb(lv_timer_t *timer);
static void rotation_done_cb(int applied_degrees, int result);
static void rotation_restore_cb(lv_timer_t *timer);
static void rotation_safety_cb(lv_timer_t *timer);
static void settings_overlay_drop(void);
static void settings_overlay_restore(void);
static void rotation_hint_set(const char *text);
static void panel_show(bool show);

static lv_indev_t *touch_indev;
static lv_obj_t *panel_screen;
static lv_display_t *panel_display;

static bool panel_open;
static bool panel_built;
static int rotate_target;

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
        snprintf(brightness_text, sizeof(brightness_text), "%u%%", (unsigned)clamp_brightness(value));
        lv_label_set_text_static(bright_value, brightness_text);
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

/*
 * ROTATE 按钮：只登记请求，不动硬件。真正的 MADCTL 写入由 BSP 在"没有帧在飞"
 * 的 LVGL tick 里做，所以这里绝不会在 QSPI 像素传输中途改面板寄存器。
 * rotate_target 跟着目标角度走，连按两次也不会因为上一次还没生效而少转一格；
 * 真正的生效角度由 BSP 记录，可用 board_display_rotation() 读。
 */
static void rotate_clicked_cb(lv_event_t *event)
{
    (void)event;

    if (!panel_open || rotation_in_progress) return;

    rotate_target = (rotate_target + 90) % 360;
    rotation_in_progress = true;
    rotation_last_result = 0;
    rotation_hint_set("");

    /* 先隐藏 overlay，并让主页面先刷一帧；真正写 MADCTL 放到下个 tick
     * （rotation_begin_cb），避免在 touch 事件派发过程中删除/重排对象树。 */
    panel_show(false);
    lv_obj_invalidate(lv_screen_active());
    if (rotation_begin_timer != NULL)
    {
        lv_timer_delete(rotation_begin_timer);
        rotation_begin_timer = NULL;
    }
    rotation_begin_timer = lv_timer_create(rotation_begin_cb, 40, NULL);
    lv_timer_set_repeat_count(rotation_begin_timer, 1);
    app_ui_note_activity();
}

static lv_obj_t *panel_label(lv_obj_t *parent, const char *text, const lv_font_t *font,
                             uint32_t color, int32_t x, int32_t y)
{
    lv_obj_t *label = lv_label_create(parent);
    lv_label_set_text_static(label, text);
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
    flat_rect(overlay, 0);
    lv_obj_set_size(overlay, PANEL_W, PANEL_H);
    lv_obj_set_pos(overlay, 0, 0);
    lv_obj_set_scrollable(overlay, false);
    lv_obj_set_clickable(overlay, true);
    lv_obj_add_event_cb(overlay, overlay_clicked_cb, LV_EVENT_CLICKED, NULL);

    panel_label(overlay, "Function settings", &lv_font_montserrat_28, 0xffffff, 24, 18);

    lv_obj_t *close = lv_button_create(overlay);
    flat_rect(close, 1);
    lv_obj_set_size(close, 56, 56);
    lv_obj_set_pos(close, PANEL_W - 56 - 20, 14);
    lv_obj_add_event_cb(close, close_clicked_cb, LV_EVENT_SHORT_CLICKED, NULL);
    lv_obj_t *close_label = lv_label_create(close);
    lv_label_set_text_static(close_label, LV_SYMBOL_CLOSE);
    lv_obj_set_style_text_font(close_label, &lv_font_montserrat_28, 0);
    lv_obj_set_style_text_color(close_label, lv_color_white(), 0);
    lv_obj_center(close_label);

    lv_obj_t *rotate = lv_button_create(overlay);
    flat_rect(rotate, 2);
    lv_obj_set_size(rotate, 150, 96);
    lv_obj_set_pos(rotate, 24, 120);
    lv_obj_add_event_cb(rotate, rotate_clicked_cb, LV_EVENT_SHORT_CLICKED, NULL);
    rotate_label = lv_label_create(rotate);
    lv_label_set_text_static(rotate_label, "ROTATE\n0 deg");
    lv_obj_set_style_text_font(rotate_label, &lv_font_montserrat_20, 0);
    lv_obj_set_style_text_color(rotate_label, lv_color_white(), 0);
    lv_obj_set_style_text_align(rotate_label, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_center(rotate_label);

    /* 旋转失败/内存不足时的可见提示（默认空）。 */
    rotate_hint = panel_label(overlay, "", &lv_font_montserrat_20, 0xe5534b, 24, 226);

    panel_label(overlay, "Brightness", &lv_font_montserrat_20, PANEL_MUTED, BRIGHT_X1, 52);
    bright_value = panel_label(overlay, "60%", &lv_font_montserrat_28, 0xffffff, BRIGHT_X1 + 96, 44);

    /* Track (visual only) and knob. */
    bright_track = lv_obj_create(overlay);
    flat_rect(bright_track, 3);
    lv_obj_set_size(bright_track, TRACK_X2 - TRACK_X1, TRACK_Y2 - TRACK_Y1);
    lv_obj_set_pos(bright_track, TRACK_X1, TRACK_Y1);
    lv_obj_clear_flag(bright_track, LV_OBJ_FLAG_CLICKABLE);

    bright_knob = lv_obj_create(overlay);
    flat_rect(bright_knob, 4);
    lv_obj_set_size(bright_knob, KNOB_SIZE, KNOB_SIZE);
    lv_obj_clear_flag(bright_knob, LV_OBJ_FLAG_CLICKABLE);

    /* Wide, transparent hit area above the track: this is what the finger
     * actually hits, so the slider never depends on a 26 px widget. */
    bright_hot = lv_obj_create(overlay);
    lv_obj_remove_style_all(bright_hot);
    lv_obj_set_size(bright_hot, BRIGHT_X2 - BRIGHT_X1, BRIGHT_Y2 - BRIGHT_Y1);
    lv_obj_set_pos(bright_hot, BRIGHT_X1, BRIGHT_Y1);
    lv_obj_set_scrollable(bright_hot, false);
    lv_obj_set_clickable(bright_hot, true);
    lv_obj_add_event_cb(bright_hot, bright_event_cb, LV_EVENT_ALL, NULL);

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

/* 回收 overlay 占用的 LVGL 池：整棵对象树删除，旋转恢复时按需重建。 */
static void settings_overlay_drop(void)
{
    lv_mem_monitor_t mon;

    if (overlay == NULL) return;
    lv_obj_del(overlay);
    overlay = NULL;
    rotate_label = NULL;
    rotate_hint = NULL;
    bright_value = NULL;
    bright_track = NULL;
    bright_knob = NULL;
    bright_hot = NULL;
    panel_built = false;
    rotation_overlay_dropped = true;
    lv_obj_invalidate(lv_screen_active());
    lv_mem_monitor(&mon);
    ESP_LOGI(TAG, "settings: rotation: overlay dropped to reclaim lvgl, free=%u biggest=%u",
             (unsigned)mon.free_size, (unsigned)mon.free_biggest_size);
}

/* 恢复设置页：被删掉则重建整棵对象树，再按需重绘，保证滑条/按钮/关闭都可用。 */
static void settings_overlay_restore(void)
{
    lv_mem_monitor_t mon;

    if (rotation_overlay_dropped)
    {
        rotation_overlay_dropped = false;
        if (!panel_built) panel_build();
    }
    if (overlay == NULL) return;
    panel_show(true);
    brightness_refresh_widgets();
    lv_obj_invalidate(overlay);
    lv_mem_monitor(&mon);
    ESP_LOGI(TAG, "settings: rotation: overlay restored, mem free=%u biggest=%u",
             (unsigned)mon.free_size, (unsigned)mon.free_biggest_size);
}

static void rotation_hint_set(const char *text)
{
    if (rotate_hint == NULL) return;
    lv_label_set_text_static(rotate_hint, text); /* 所有调用方均传静态字串。 */
}

/* 隐藏 overlay 后的下一 tick 才请求旋转：内存不足就先删 overlay 回收；仍不足
 * 则放弃本次旋转（不动硬件），恢复 overlay 并给用户可见提示。 */
static void rotation_begin_cb(lv_timer_t *timer)
{
    lv_mem_monitor_t mon;

    (void)timer;
    rotation_begin_timer = NULL;
    if (!rotation_in_progress) return;

    lv_mem_monitor(&mon);
    if (mon.free_size < 4096 || mon.free_biggest_size < 2048)
    {
        ESP_LOGW(TAG, "settings: rotation: lvgl low before rotate (free=%u biggest=%u), reclaiming overlay",
                 (unsigned)mon.free_size, (unsigned)mon.free_biggest_size);
        settings_overlay_drop();
        lv_mem_monitor(&mon);
        if (mon.free_size < 4096 || mon.free_biggest_size < 2048)
        {
            ESP_LOGE(TAG, "settings: rotation skipped: lvgl memory too low free=%u biggest=%u",
                     (unsigned)mon.free_size, (unsigned)mon.free_biggest_size);
            rotation_last_result = 1; /* LVGL_ROTATION_LOW_MEM */
            rotation_in_progress = false;
            settings_overlay_restore();
            rotation_hint_set("内存不足，请稍后重试");
            return;
        }
    }

    board_display_set_rotation_done_cb(rotation_done_cb);
    ESP_LOGI(TAG, "settings: rotation request %d (current %d), overlay hidden, mem free=%u biggest=%u",
             rotate_target, board_display_rotation(), (unsigned)mon.free_size,
             (unsigned)mon.free_biggest_size);
    (void)board_display_rotation_set(rotate_target);

    /* 完成回调丢失时的兜底：800 ms 后无论如何恢复 overlay，设置页不能消失。 */
    if (rotation_safety_timer != NULL) lv_timer_delete(rotation_safety_timer);
    rotation_safety_timer = lv_timer_create(rotation_safety_cb, 800, NULL);
    lv_timer_set_repeat_count(rotation_safety_timer, 1);
}

/* BSP 在 LVGL tick 里完成旋转（成功/内存不足/显示忙/MADCTL 失败）后回调这里。 */
static void rotation_done_cb(int applied_degrees, int result)
{
    rotation_last_result = result;
    rotation_frame_probe = result == 0 ? ROT_FRAME_MAIN : ROT_FRAME_NONE;
    ESP_LOGI(TAG, "rotation diag: hardware result=%d applied=%d", result, applied_degrees);
    if (applied_degrees != rotate_target) rotate_target = applied_degrees;

    if (rotation_safety_timer != NULL)
    {
        lv_timer_delete(rotation_safety_timer);
        rotation_safety_timer = NULL;
    }
    if (rotation_restore_timer != NULL) lv_timer_delete(rotation_restore_timer);
    /* 延迟 ~120 ms 再恢复：让旋转后的整屏重绘先完成，否则 overlay 又会被算进
     * 同一帧重绘，内存问题原样复现。 */
    rotation_restore_timer = lv_timer_create(rotation_restore_cb, 120, NULL);
    lv_timer_set_repeat_count(rotation_restore_timer, 1);
}

static void rotation_restore_cb(lv_timer_t *timer)
{
    lv_mem_monitor_t mon;

    (void)timer;
    rotation_restore_timer = NULL;
    if (!rotation_in_progress) return;
    rotation_in_progress = false;

    if (rotation_frame_probe == ROT_FRAME_MAIN) {
        ESP_LOGW(TAG, "rotation diag: no rotated main refresh before overlay restore");
    }
    rotation_frame_probe = ROT_FRAME_OVERLAY;
    ESP_LOGI(TAG, "rotation diag: restoring settings overlay");
    settings_overlay_restore();
    if (rotate_label != NULL) {
        static const char *const labels[] = {"ROTATE\n0 deg", "ROTATE\n90 deg", "ROTATE\n180 deg", "ROTATE\n270 deg"};
        lv_label_set_text_static(rotate_label, labels[(unsigned)rotate_target / 90U % 4U]);
    }
    if (rotation_last_result == 1) rotation_hint_set("内存不足，请稍后重试");
    else if (rotation_last_result == 2) rotation_hint_set("显示忙，请重试");
    else if (rotation_last_result == 3) rotation_hint_set("旋转失败，请重试");

    lv_mem_monitor(&mon);
    ESP_LOGI(TAG, "settings: rotation done applied=%d result=%d, rotation %d, lvgl free=%u biggest=%u",
             rotate_target, rotation_last_result, board_display_rotation(),
             (unsigned)mon.free_size, (unsigned)mon.free_biggest_size);
    app_ui_note_activity();
}

/* 完成回调超时兜底：保留原方向，恢复 overlay 并提示。 */
static void rotation_safety_cb(lv_timer_t *timer)
{
    (void)timer;
    rotation_safety_timer = NULL;
    if (!rotation_in_progress) return;
    rotation_in_progress = false;
    rotation_last_result = 4;
    ESP_LOGE(TAG, "settings: rotation aborted (no completion), restoring overlay");
    settings_overlay_restore();
    rotation_hint_set("旋转换向超时，请重试");
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

static void rotation_refresh_probe(lv_event_t *event)
{
    (void)event;
    if (rotation_frame_probe == ROT_FRAME_NONE) return;
    lv_mem_monitor_t mon;
    lv_mem_monitor(&mon);
    ESP_LOGI(TAG, "rotation diag: %s refresh submitted free=%u biggest=%u",
             rotation_frame_probe == ROT_FRAME_MAIN ? "rotated main" : "restored overlay",
             (unsigned)mon.free_size, (unsigned)mon.free_biggest_size);
    rotation_frame_probe = ROT_FRAME_NONE;
}

void settings_panel_init(lv_obj_t *screen, lv_display_t *display, lv_indev_t *indev)
{
    panel_screen = screen;
    panel_display = display;
    if (display != NULL) lv_display_add_event_cb(display, rotation_refresh_probe, LV_EVENT_REFR_READY, NULL);
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
    rotate_target = board_display_rotation();
    rotation_hint_set("");

    brightness_refresh_widgets();
    panel_show(true);

    app_busy_acquire(APP_BUSY_SETTINGS);
    app_ui_note_activity();
    ESP_LOGI(TAG, "settings: panel open (full %dx%d), brightness %d, rotation %d, busy 0x%x",
             panel_display != NULL ? (int)lv_display_get_horizontal_resolution(panel_display) : 0,
             panel_display != NULL ? (int)lv_display_get_vertical_resolution(panel_display) : 0,
             app_ui_brightness(), board_display_rotation(), app_busy_mask());
}

void settings_panel_close(void)
{
    if (!panel_open) return;
    /* 旋转的隐藏/恢复必须成对：进行中先忽略关闭，避免设置页永久消失。 */
    if (rotation_in_progress) return;

    panel_open = false;
    swipe_tracking = false;
    close_tracking = false;
    panel_show(false);
    app_busy_release(APP_BUSY_SETTINGS);
    app_ui_note_activity();
    ESP_LOGI(TAG, "settings: panel close, brightness %d, rotation %d, busy 0x%x",
             app_ui_brightness(), board_display_rotation(), app_busy_mask());
}
