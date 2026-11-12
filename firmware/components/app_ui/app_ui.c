/* LVGL UI for Codex Air Remote (moved out of main/app_main.c).
 * Owns the screen widgets, the 125 ms render timer and all touch interaction.
 * main only reports capabilities and calls app_ui_init(). */
#include <stdio.h>
#include <string.h>

#include "air_mouse.h"
#include "app_busy.h"
#include "app_key.h"
#include "app_ui.h"
#include "ble_mouse.h"
#include "board.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "lvgl_private.h"
#include "rtc_board.h"
#include "standby_glyphs.h"
#include "voice.h"

/* Standby clock face: 160 px Montserrat with only 0123456789: (generated with
 * lv_font_conv, see fonts/ui_font_standby_160.c). LVGL's built-in faces stop at
 * 48 px; the bitmap lives in rodata, so it costs flash, not LVGL heap. */

static const char *TAG = "air_remote";
static lv_obj_t *date_label, *clock_label, *bt_label, *battery_label, *status_label;
/* 字形蒙版分配失败次数：任何文字（含待机数字）出现“占位在、像素没”都会在这里计数，
 * 并且每秒的待机日志都会打印它，不再依赖“看起来有没有像素”。 */
static volatile unsigned mask_fail_count;
/* 待机数字资源自检结果（0=未检查，1=全部字形都有像素）。 */
static int standby_glyph_pixels_ok;
static lv_obj_t *gyro_button, *voice_button;
static lv_obj_t *a_button, *b_button, *a_hint, *b_hint;
static lv_obj_t *hint_panel, *hint_label;
static bool mouse_active, mouse_ready, voice_ready, ble_ready;
/* Transient status line. Empty in idle: the old "Tap a mode to begin" hint is
 * gone, so nothing sits at the bottom of the screen unless something happened. */
static const char *mouse_message = "";
static uint32_t mouse_message_until;
static uint32_t last_interaction, last_battery_update, last_clock_update;
/* Set by app_ui_refresh_clock() after the host changes the time, so the next
 * render tick (<= 125 ms) repaints instead of waiting for the 1 s cadence. */
static volatile bool clock_dirty = true;
static int brightness = -1;

/* Standby page: after a minute without any interaction the panel goes black
 * with just the wall clock and the backlight drops to
 * UI_STANDBY_BRIGHTNESS_PERCENT. Every input source calls note_activity();
 * long-lived features hold the board through app_busy instead of adding their
 * own exception here. */
#define UI_STANDBY_IDLE_MS 60000
#define UI_STANDBY_BRIGHTNESS_PERCENT 80
#define UI_BRIGHTNESS_ACTIVE 100
#define UI_BRIGHTNESS_IDLE 60

/* 待机页第一行是五个固定字形格（H H : M M）。数字在每个格内按字体度量
 * （adv_w / ofs_x / ofs_y / box_w / box_h）居中，视觉位置与字体渲染一致；
 * 数字格 104 px、冒号格 34 px，合计 4 x 104 + 34 = 450 px，左右各留 15 px。
 * 字形像素来自 flash 里的 A8 资源（fonts/standby_glyphs.c），不再让 LVGL
 * 现算 11~12.5 KB 的字形蒙版，因此不会再出现"格子占位在、像素没"的失败。 */
#define STANDBY_DIGIT_W 104
#define STANDBY_COLON_W 34
/* 秒行用现成的 montserrat_48，紧跟第一行正下方，两行作为一个整体垂直居中。 */
#define STANDBY_SEC_GAP 30
/* 右上角电量沿用主界面的边距（-24, 22），待机页只保留电量，不放蓝牙图标。 */
#define STANDBY_BATTERY_X (-24)
#define STANDBY_BATTERY_Y 22

static lv_obj_t *standby_page, *standby_row, *standby_sec_label;
/* 主屏幕，用于待机页离场时把电量标签挂回去。 */
static lv_obj_t *main_screen;
static lv_obj_t *standby_cell_img[5];
static char standby_cell_char[5] = {'0', '0', ':', '0', '0'};
static const int standby_cell_x[5] = {0, 104, 208, 242, 346};
static const int standby_cell_w[5] = {STANDBY_DIGIT_W, STANDBY_DIGIT_W,
                                      STANDBY_COLON_W,
                                      STANDBY_DIGIT_W, STANDBY_DIGIT_W};
static lv_indev_t *touch_indev;
static bool standby_active;
static volatile uint32_t last_activity;
static int standby_brightness = UI_BRIGHTNESS_IDLE;
static voice_state_t last_voice_seen = VOICE_IDLE;
/* Set by the console test hook (app_ui.h) and consumed in render(). */
static volatile bool standby_tap_request;
static volatile char debug_click_request;
/* 强制待机请求：由第三键或 app_ui_standby_now() 置位，render() 在 LVGL
 * 上下文里执行，避免按键任务直接碰 LVGL。 */
static volatile bool standby_request;
/* 真实触摸触发的唤醒请求：indev 回调只置位，render() 再切页。 */
static volatile bool standby_wake_request;
static unsigned touch_events;
static unsigned wake_events;
static int64_t standby_request_us;
static bool standby_force_pending;
static uint32_t standby_force_log;

/* Any interaction restarts the idle countdown. Also called from the USB
 * console task (app_ui_refresh_clock): a 32-bit tick read/write is atomic
 * enough here and the flag it already touches works the same way. */
static void note_activity(void)
{
    last_activity = lv_tick_get();
}

/* Centre popup used for the Gyro calibration feedback. */
typedef enum { HINT_NONE, HINT_CALIBRATING, HINT_FAILED } hint_mode_t;
static hint_mode_t hint_mode;
static uint32_t hint_deadline;
static bool icon_bt_linked, icon_bt_ready; /* cached so the icon colour only changes on transitions */

static bool voice_busy(voice_state_t s)
{
    return s == VOICE_CONNECTING || s == VOICE_RECORDING || s == VOICE_RECOGNIZING;
}

static const char *voice_message(voice_state_t s)
{
    switch (s) {
    case VOICE_CONNECTING:    return "Connecting to PC... B cancels";
    case VOICE_RECORDING:     return "Recording  /  A sends, B cancels";
    case VOICE_RECOGNIZING:   return "Finishing Codex dictation...";
    case VOICE_SENT:          return "Sent to Codex";
    case VOICE_SUBMITTED:     return "Codex send requested";
    case VOICE_DRAFTED:       return "Draft requested in Codex";
    case VOICE_SAVED:         return "Saved on PC. Send unconfirmed";
    case VOICE_CANCELLED:     return "Recording cancelled";
    case VOICE_NO_WIFI:       return "Wi-Fi unavailable. Check USB setup";
    case VOICE_NO_PC:         return "PC companion unavailable";
    case VOICE_AUDIO_ERROR:   return "Microphone error";
    case VOICE_NETWORK_ERROR: return "Audio connection lost";
    case VOICE_NO_SPEECH:     return "No speech detected";
    case VOICE_SEND_ERROR:    return "Check Codex and PC audio setup";
    default:                  return "";
    }
}

/* Status texts are events, not a permanent hint: auto-clear them so an idle
 * screen stays clean (only the clock and the icons remain). */
static void set_message(const char *text)
{
    mouse_message = text;
    mouse_message_until = text[0] ? lv_tick_get() + 3000 : 0;
}

static void mouse_clicked(lv_event_t *event)
{
    last_interaction = lv_tick_get();
    if (voice_busy(voice_state())) return;
    if (mouse_active) {
        mouse_stop();
        mouse_active = false;
        set_message("Mouse stopped");
    } else if (mouse_ready && ble_ready && mouse_start() == ESP_OK) {
        mouse_active = true;
    } else {
        set_message("Mouse hardware unavailable");
    }
}

static void voice_clicked(lv_event_t *event)
{
    last_interaction = lv_tick_get();
    if (mouse_active || voice_busy(voice_state())) return;
    set_message(voice_ready && voice_start() == ESP_OK ? "" : "PC voice unavailable");
}

static void action_touch(lv_event_t *event)
{
    lv_event_code_t code = lv_event_get_code(event);
    bool a = lv_event_get_target(event) == a_button;
    if (code == LV_EVENT_PRESSED || code == LV_EVENT_SHORT_CLICKED) {
        last_interaction = lv_tick_get();
        ESP_LOGI(TAG, "ui: %s touch, code %d", a ? "A" : "B", (int)code);
    }
    if (mouse_active) {
        uint8_t button = a ? MOUSE_LEFT : MOUSE_RIGHT;
        if (code == LV_EVENT_PRESSED) mouse_button(button, true);
        if (code == LV_EVENT_RELEASED || code == LV_EVENT_PRESS_LOST) mouse_button(button, false);
        return;
    }
    if (code != LV_EVENT_SHORT_CLICKED) return;
    voice_state_t voice = voice_state();
    if (voice == VOICE_RECORDING || (!a && voice == VOICE_CONNECTING)) {
        voice_finish(a ? VOICE_ACTION_SEND : VOICE_ACTION_CANCEL);
    }
}

static int battery_percent(void)
{
    return board_battery_percent();
}

static void update_label(lv_obj_t *label, const char *value)
{
    if (strcmp(lv_label_get_text(label), value) != 0) lv_label_set_text(label, value);
}

/* Centre popup. It is not clickable, so A/B stay usable underneath while the
 * board settles (the old bottom line told the user to hold still but could be
 * missed while staring at the cursor). */
static void show_hint(const char *text, uint32_t auto_hide_ms)
{
    if (!hint_panel) return;
    update_label(hint_label, text);
    hint_deadline = auto_hide_ms ? lv_tick_get() + auto_hide_ms : 0;
    lv_obj_set_hidden(hint_panel, false);
}

static void hide_hint(void)
{
    hint_mode = HINT_NONE;
    hint_deadline = 0;
    if (hint_panel) lv_obj_set_hidden(hint_panel, true);
}

static void apply_brightness(int requested)
{
    if (requested != brightness && board_set_brightness(requested) == ESP_OK) brightness = requested;
}

/* The board counts as "in use" while any long-lived feature holds it: a voice
 * session from start to its terminal state, the gyro/mouse runtime, and
 * blocking console commands. Those holds live in app_busy so a new feature
 * only has to acquire/release there instead of patching the standby timer. */
static bool standby_hold(void)
{
    return app_busy_active();
}

/* 待机页字形自检：把每个 A8 资源与字体原始 4bpp 数据逐像素比对（字体 fmt_txt 的
 * 行是连续打包的，位偏移 (y*box_w + x)*4，等价于 lv_font_get_glyph_bitmap 的结果），
 * 同时校验「stride == box_w」这个资源不变量。任何差异都会打 E GLYPH MISMATCH，
 * 返回 1 仅当 11 个字形全部逐字节一致 —— 这样"画的是不是对的字"不再靠人眼。 */
static int standby_font_check(void)
{
    const lv_font_fmt_txt_dsc_t *fdsc = (const lv_font_fmt_txt_dsc_t *)ui_font_standby_160.dsc;
    char report[320];
    size_t used = 0;
    int complete = 1;

    report[0] = 0;
    if (fdsc == NULL) return 0;
    for (uint32_t glyph = '0'; glyph <= ':'; glyph++) {
        const lv_image_dsc_t *image = standby_glyph_image((char)glyph);
        const lv_font_fmt_txt_glyph_dsc_t *gdsc = &fdsc->glyph_dsc[1 + (glyph - '0')];
        const uint8_t *source;
        unsigned mismatch = 0;
        unsigned total;
        int written;

        if (image == NULL || (int32_t)image->header.w != gdsc->box_w ||
            (int32_t)image->header.h != gdsc->box_h ||
            (int32_t)image->header.stride != gdsc->box_w) {
            complete = 0;
            written = snprintf(report + used, sizeof(report) - used, " '%c':BAD", (char)glyph);
        } else {
            total = (unsigned)(gdsc->box_w * gdsc->box_h);
            source = &fdsc->glyph_bitmap[gdsc->bitmap_index];
            for (uint32_t y = 0; y < gdsc->box_h; y++) {
                for (uint32_t x = 0; x < gdsc->box_w; x++) {
                    uint32_t bit = (y * gdsc->box_w + x) * 4;
                    uint8_t packed = source[bit >> 3];
                    uint8_t nibble = (bit & 7) == 0 ? (uint8_t)(packed >> 4) : (uint8_t)(packed & 0x0F);
                    uint8_t expected = (uint8_t)(nibble * 17);
                    if (image->data[y * image->header.stride + x] != expected) mismatch++;
                }
            }
            if (mismatch != 0) {
                complete = 0;
                ESP_LOGE(TAG, "GLYPH MISMATCH '%c' px=%u of %u (%u.%02u%%)", (char)glyph, mismatch,
                         total, (unsigned)(mismatch * 100u / total),
                         (unsigned)(mismatch * 10000u / total % 100u));
            }
            written = snprintf(report + used, sizeof(report) - used, " '%c':%u/%u", (char)glyph,
                               mismatch, total);
        }
        if (written < 0) break;
        used += (size_t)written;
        if (used >= sizeof(report) - 1) break;
    }
    ESP_LOGI(TAG, "standby: glyphs vs font%s", report);

    return complete;
}

/* 把一个字形画进第 index 格：像素来自 flash 里的 A8 资源，位置按字体度量计算，
 * 与 LVGL 字体渲染的位置一致（adv 居中 + ofs_x，基线 114 - box_h - ofs_y）。
 * 只做 set_src 与 set_pos，不分配任何堆内存。 */
static bool standby_set_glyph(int index, char glyph)
{
    lv_font_glyph_dsc_t dsc = {0};
    const lv_image_dsc_t *image = standby_glyph_image(glyph);
    int32_t x;
    int32_t y;

    if (image == NULL || !lv_font_get_glyph_dsc(&ui_font_standby_160, &dsc, (uint32_t)glyph, 0))
    {
        return false;
    }
    lv_image_set_src(standby_cell_img[index], image);
    x = standby_cell_x[index] + (standby_cell_w[index] - dsc.adv_w) / 2 + dsc.ofs_x;
    y = (ui_font_standby_160.line_height - ui_font_standby_160.base_line) - dsc.box_h - dsc.ofs_y;
    lv_obj_set_pos(standby_cell_img[index], x, y);
    standby_cell_char[index] = glyph;

    return true;
}

/* 逐格自检：图片已设置、尺寸与字形度量一致、坐标在 0..479 内。任何一格不合法
 * 都返回 STANDBY LAYOUT ERROR，绝不静默。 */
static int standby_layout_ok(void)
{
    for (int i = 0; i < 5; i++)
    {
        const lv_image_dsc_t *image = (const lv_image_dsc_t *)lv_image_get_src(standby_cell_img[i]);
        lv_font_glyph_dsc_t dsc = {0};
        lv_area_t area;

        if (image == NULL ||
            !lv_font_get_glyph_dsc(&ui_font_standby_160, &dsc, (uint32_t)standby_cell_char[i], 0))
        {
            return 0;
        }
        lv_obj_get_coords(standby_cell_img[i], &area);
        if (area.x1 < 0 || area.y1 < 0 || area.x2 > 479 || area.y2 > 479)
        {
            return 0;
        }
        if ((int32_t)image->header.w != dsc.box_w || (int32_t)image->header.h != dsc.box_h)
        {
            return 0;
        }
    }

    return 1;
}

/* 逐格打印实际坐标与字形度量：坐标越界、尺寸不符、图片缺失都能直接看出来。 */
static void standby_log_geometry(const char *when)
{
    lv_area_t page_area;
    lv_area_t row_area;

    lv_obj_update_layout(standby_page);
    lv_obj_get_coords(standby_page, &page_area);
    lv_obj_get_coords(standby_row, &row_area);
    ESP_LOGI(TAG, "standby: geom(%s) page %d,%d..%d,%d w=%d; row %d,%d..%d,%d w=%d h=%d",
             when, (int)page_area.x1, (int)page_area.y1, (int)page_area.x2, (int)page_area.y2,
             (int)lv_obj_get_width(standby_page), (int)row_area.x1, (int)row_area.y1,
             (int)row_area.x2, (int)row_area.y2, (int)lv_obj_get_width(standby_row),
             (int)lv_obj_get_height(standby_row));
    for (int i = 0; i < 5; i++)
    {
        lv_font_glyph_dsc_t dsc = {0};
        lv_area_t area;

        lv_obj_get_coords(standby_cell_img[i], &area);
        if (!lv_font_get_glyph_dsc(&ui_font_standby_160, &dsc, (uint32_t)standby_cell_char[i], 0))
        {
            ESP_LOGE(TAG, "standby: geom(%s) cell%d glyph '%c' missing", when, i, standby_cell_char[i]);
            continue;
        }
        ESP_LOGI(TAG, "standby: geom(%s) cell%d '%c' hex %02x x=%d..%d y=%d..%d adv=%d box=%dx%d",
                 when, i, standby_cell_char[i], (unsigned char)standby_cell_char[i],
                 (int)area.x1, (int)area.x2, (int)area.y1, (int)area.y2, dsc.adv_w,
                 dsc.box_w, dsc.box_h);
    }
    ESP_LOGI(TAG, "standby: geom(%s) layout=%s", when, standby_layout_ok() ? "ok" : "STANDBY LAYOUT ERROR");
}
/* Refresh the standby clock once a second; it keeps ticking while the page is
 * up because this runs from the same 125 ms render timer. Both rows are fed
 * from the same RTC sample, so a minute/hour carry updates HH:MM and SS in the
 * same tick. */
static void update_standby_clock(bool force)
{
    static uint32_t last_sample;
    char text[8];
    char seconds[8];
    bool changed = false;
    int second;

    if (!force && lv_tick_elaps(last_sample) < 1000) return;
    last_sample = lv_tick_get();
    rtc_board_time_text(text, sizeof(text));
    second = rtc_board_second();
    /* 时间无效时不要显示 00:00 这种假数据：大数字整行隐藏，秒行显示 "--"，
     * 等宿主（插件）校时后自动恢复。 */
    if (second < 0 || text[0] == '-') {
        for (int i = 0; i < 5; i++) lv_obj_add_flag(standby_cell_img[i], LV_OBJ_FLAG_HIDDEN);
        if (strcmp(lv_label_get_text(standby_sec_label), "--") != 0) {
            lv_label_set_text(standby_sec_label, "--");
            changed = true;
        }
        if (changed) {
            ESP_LOGW(TAG, "standby: clock invalid, placeholder shown, touches=%u wakes=%u",
                     touch_events, wake_events);
        }
        return;
    }
    for (int i = 0; i < 5; i++) lv_obj_remove_flag(standby_cell_img[i], LV_OBJ_FLAG_HIDDEN);
    if (strlen(text) < 5) return;
    for (int i = 0; i < 5; i++) {
        if (standby_cell_char[i] != text[i]) {
            if (!standby_set_glyph(i, text[i])) ESP_LOGE(TAG, "standby: glyph '%c' missing", text[i]);
            changed = true;
        }
    }
    snprintf(seconds, sizeof(seconds), "%02d", second % 100);
    if (strcmp(lv_label_get_text(standby_sec_label), seconds) != 0) {
        lv_label_set_text(standby_sec_label, seconds);
        changed = true;
    }
    if (changed) {
        int layout_ok = standby_layout_ok();

        ESP_LOGI(TAG, "standby: clock %c%c:%c%c:%s, layout=%s, glyphs=%d, mask_fail=%u, "
                 "touches=%u wakes=%u", text[0], text[1], text[3], text[4], seconds,
                 layout_ok ? "ok" : "ERROR", standby_glyph_pixels_ok,
                 (unsigned)mask_fail_count, touch_events, wake_events);
        if (!layout_ok || standby_glyph_pixels_ok != 1 || mask_fail_count != 0) {
            ESP_LOGE(TAG, "STANDBY LAYOUT ERROR: layout=%d glyphs=%d mask_fail=%u", layout_ok,
                     standby_glyph_pixels_ok, (unsigned)mask_fail_count);
        }
    }
}

/* True when the standby page is the object under this button's centre, i.e. a
 * tap there would be swallowed by the page instead of clicking the button. */
static int page_covers(lv_obj_t *button)
{
    lv_area_t area;
    lv_obj_get_coords(button, &area);
    lv_point_t center = {(area.x1 + area.x2) / 2, (area.y1 + area.y2) / 2};
    return lv_obj_hit_test(standby_page, &center) ? 1 : 0;
}

static void enter_standby(void)
{
    standby_active = true;
    standby_brightness = brightness > 0 ? brightness : UI_BRIGHTNESS_IDLE;
    lv_obj_move_to_index(standby_page, -1); /* keep it above hint_panel/status */
    lv_obj_set_hidden(standby_page, false);
    /* 电量标签是主界面那一个控件，直接挂到待机页上：同一套文本、字体与边距，
     * 数据仍由 render() 里同一个每秒刷新块更新。 */
    lv_obj_set_parent(battery_label, standby_page);
    lv_obj_align(battery_label, LV_ALIGN_TOP_RIGHT, STANDBY_BATTERY_X, STANDBY_BATTERY_Y);
    update_standby_clock(true);
    /* The page is opaque, topmost and clickable, so a wake tap lands on it.
     * The cover flags are the geometry proof for the hardware test. */
    ESP_LOGI(TAG, "standby: enter, idle %u ms, brightness %d -> %d, busy 0x%x, "
             "ble=%d gen=%u, page top=%d/%d covers voice=%d gyro=%d a=%d b=%d",
             (unsigned)lv_tick_elaps(last_activity), standby_brightness,
             UI_STANDBY_BRIGHTNESS_PERCENT, app_busy_mask(), ble_mouse_connected() ? 1 : 0,
             ble_mouse_generation(), (int)lv_obj_get_index(standby_page),
             (int)lv_obj_get_child_count(lv_obj_get_parent(standby_page)),
             page_covers(voice_button), page_covers(gyro_button), page_covers(a_button),
             page_covers(b_button));
    ESP_LOGI(TAG, "standby: row y=%d h=%d, sec y=%d h=%d, glyphs=%d, mask_fail=%u",
             (int)lv_obj_get_y(standby_row), (int)lv_obj_get_height(standby_row),
             (int)lv_obj_get_y(standby_sec_label), (int)lv_obj_get_height(standby_sec_label),
             standby_glyph_pixels_ok, (unsigned)mask_fail_count);
    ESP_LOGI(TAG, "standby: cells '%c%c%c%c%c' sec '%s', battery '%s' at %d,%d %dx%d",
             standby_cell_char[0], standby_cell_char[1], standby_cell_char[2],
             standby_cell_char[3], standby_cell_char[4],
             lv_label_get_text(standby_sec_label), lv_label_get_text(battery_label),
             (int)lv_obj_get_x(battery_label), (int)lv_obj_get_y(battery_label),
             (int)lv_obj_get_width(battery_label), (int)lv_obj_get_height(battery_label));
    standby_log_geometry("enter");
    lv_mem_monitor_t mem;
    lv_mem_monitor(&mem);
    ESP_LOGI(TAG, "standby: heap 8bit free=%u largest=%u, internal free=%u largest=%u, lvgl free=%u",
             (unsigned)heap_caps_get_free_size(MALLOC_CAP_8BIT),
             (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_8BIT),
             (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL),
             (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL),
             (unsigned)mem.free_size);
}

static void leave_standby(const char *why)
{
    standby_active = false;
    lv_obj_set_hidden(standby_page, true);
    /* 电量标签挂回主屏幕原来的右上角位置（边距与主界面一致）。 */
    lv_obj_set_parent(battery_label, main_screen);
    lv_obj_align(battery_label, LV_ALIGN_TOP_RIGHT, STANDBY_BATTERY_X, STANDBY_BATTERY_Y);
    /* Back to the level the panel had before the page took over (60% in the
     * steady state) instead of a hard-coded 100; the render policy keeps owning
     * the 25 s idle step from there. */
    if (board_set_brightness(standby_brightness) == ESP_OK) brightness = standby_brightness;
    clock_dirty = true;
    ESP_LOGI(TAG, "standby: wake (%s), brightness %d, ble=%d gen=%u", why, standby_brightness,
             ble_mouse_connected() ? 1 : 0, ble_mouse_generation());
}

/* Every touch, whichever object it hits. Waking consumes the press: it was
 * routed to the standby page (see enter_standby), so no button sees it. */
static void touch_pressed(lv_event_t *event)
{
    touch_events++;
    note_activity();
    /* 只置位，不在这里动对象树：唤醒要隐藏页面、把电量标签挂回主屏幕，那属于
     * 结构变更，必须回到 render() 的 LVGL 循环里做，否则会在 indev 派发过程中
     * 改对象树（实测症状：待机页摸不醒 / 醒了点不动）。 */
    if (standby_active) standby_wake_request = true;
    ESP_LOGI(TAG, "ui: real touch #%u, standby=%d", touch_events, standby_active ? 1 : 0);
}

/* 强制待机的一步：先安全停掉占用方，等 app_busy 真正释放后才切页。
 * 绝不允许“后台还在录音/发 HID，屏幕却黑了”，所以占用未释放时保持亮屏并
 * 每秒打印一次等待状态，由下一次渲染 tick 重试。 */
static void force_standby_step(void)
{
    voice_state_t voice = voice_state();
    int64_t waited_ms;

    if (mouse_active)
    {
        mouse_stop();
        mouse_active = false;
        ESP_LOGI(TAG, "standby: key stopped gyro mouse");
    }
    if (voice == VOICE_CONNECTING || voice == VOICE_RECORDING)
    {
        voice_finish(VOICE_ACTION_CANCEL);
        ESP_LOGI(TAG, "standby: key cancels voice session (state %d)", (int)voice);
    }
    if (app_busy_active())
    {
        standby_force_pending = true;
        if (lv_tick_elaps(standby_force_log) >= 1000)
        {
            standby_force_log = lv_tick_get();
            ESP_LOGI(TAG, "standby: force pending, busy 0x%x", app_busy_mask());
        }
        return;
    }
    standby_force_pending = false;
    waited_ms = (esp_timer_get_time() - standby_request_us) / 1000;
    enter_standby();
    ESP_LOGI(TAG, "standby: key force done, key->standby %lld ms", (long long)waited_ms);
}

/* 第三键回调和公开 API 都走这里：只置位，LVGL 操作留到 render()。 */
void app_ui_standby_now(void)
{
    standby_request_us = esp_timer_get_time();
    standby_request = true;
}

/* 按键任务上下文：不得直接调用 LVGL，只置请求位。 */
static void key_short_press(void)
{
    ESP_LOGI(TAG, "key: short press -> standby");
    app_ui_standby_now();
}

static void render(lv_timer_t *timer)
{
    voice_state_t voice = voice_state();
    bool recording_mode = voice_busy(voice);
    bool linked = ble_mouse_connected();

    /* Touches arrive in touch_pressed() through the input device; the USB
     * console calls note_activity() from app_ui_refresh_clock(); voice and gyro
     * hold the board through app_busy below. */
    if (voice != last_voice_seen) {
        last_voice_seen = voice;
        note_activity();
    }

    /* Console test hook: inject the same input-device press a finger makes. */
    if (standby_tap_request) {
        standby_tap_request = false;
        if (standby_active && touch_indev) {
            ESP_LOGI(TAG, "standby: console tap");
            lv_indev_send_event(touch_indev, LV_EVENT_PRESSED, standby_page);
            lv_indev_send_event(touch_indev, LV_EVENT_RELEASED, standby_page);
        }
    }

    /* 真实触摸唤醒：indev 回调只置位，这里（LVGL 循环内）才隐藏页面、把电量
     * 标签挂回主屏幕，避免在输入派发过程中改对象树。 */
    if (standby_wake_request) {
        standby_wake_request = false;
        if (standby_active) {
            note_activity();
            wake_events++;
            leave_standby("touch");
        }
    }

    /* 第三键 / app_ui_standby_now()：待机时唤醒，否则强制进待机。 */
    if (standby_request) {
        standby_request = false;
        if (standby_active) {
            note_activity();
            wake_events++;
            leave_standby("key");
        } else {
            force_standby_step();
        }
    } else if (standby_force_pending && !standby_active) {
        force_standby_step();
    }

    /* Console test hook: play the click a finger would make on Gyro/Voice. */
    if (debug_click_request) {
        char which = debug_click_request;
        debug_click_request = 0;
        lv_obj_t *button = which == 'g' ? gyro_button : which == 'v' ? voice_button : NULL;
        if (button) {
            ESP_LOGI(TAG, "console click %c", which);
            lv_obj_send_event(button, LV_EVENT_SHORT_CLICKED, NULL);
        }
    }

    /* 电量每秒刷新一次：主界面与待机页共用同一个控件（待机时该标签被挂到
     * 待机页上，见 enter_standby），所以待机页没有自己的轮询定时器；待机页
     * 只显示电量，不显示蓝牙图标。 */
    if (lv_tick_elaps(last_battery_update) >= 1000) {
        last_battery_update = lv_tick_get();
        int percent = battery_percent();
        if (percent >= 0) {
            lv_label_set_text_fmt(battery_label, LV_SYMBOL_BATTERY_FULL " %d%%", percent);
        } else {
            update_label(battery_label, LV_SYMBOL_BATTERY_EMPTY " --");
        }
    }

    if (standby_active) {
        if (standby_hold()) {
            leave_standby("feature busy");
        } else {
            update_standby_clock(false);
            apply_brightness(UI_STANDBY_BRIGHTNESS_PERCENT);
            return; /* the page hides every other widget; nothing else to draw */
        }
    } else if (standby_hold()) {
        /* A voice session, the gyro runtime or a console command owns the
         * board: no countdown runs, and it starts over once the hold ends. */
        note_activity();
    } else if (lv_tick_elaps(last_activity) >= UI_STANDBY_IDLE_MS) {
        enter_standby();
        return;
    }

    /* Date + time in the top-left corner. Sampling once per second keeps the
     * I2C reads out of the 125 ms path, and update_label() only calls
     * lv_label_set_text() when the text really changed. */
    if (clock_dirty || lv_tick_elaps(last_clock_update) >= 1000) {
        clock_dirty = false;
        last_clock_update = lv_tick_get();
        char date[16], time[8];
        rtc_board_date_text(date, sizeof(date));
        rtc_board_time_text(time, sizeof(time));
        update_label(date_label, date);
        update_label(clock_label, time);
    }

    /* BLE state moved from the removed text line into an icon next to the
     * battery: bright when the host is connected, dim when it is not. */
    if (linked != icon_bt_linked || ble_ready != icon_bt_ready) {
        icon_bt_linked = linked;
        icon_bt_ready = ble_ready;
        lv_obj_set_style_text_color(bt_label, linked && ble_ready ? lv_color_white() :
                                                          lv_color_hex(0x55606e), 0);
    }

    /* A failed zero-rate calibration stops the sensor task silently; report it
     * in the popup and drop back to idle so the button can be retried. The
     * explicit mouse_stop() also releases the gyro busy hold: this failure path
     * never goes through the button callback that normally stops the mode. */
    if (mouse_active && mouse_failed()) {
        mouse_stop();
        mouse_active = false;
        hint_mode = HINT_FAILED;
        show_hint("Calibration failed, try again", 1500);
    }
    if (mouse_active && !mouse_calibrated()) {
        if (hint_mode != HINT_CALIBRATING) {
            hint_mode = HINT_CALIBRATING;
            show_hint("Hold the board still...", 0);
        }
    } else if (hint_mode == HINT_CALIBRATING) {
        hide_hint(); /* calibrated, or the user left the mode */
    }
    if (hint_deadline && (int32_t)(lv_tick_get() - hint_deadline) >= 0) hide_hint();

    if (mouse_message_until && (int32_t)(lv_tick_get() - mouse_message_until) >= 0) {
        mouse_message = "";
        mouse_message_until = 0;
    }
    const char *status = "";
    if (voice != VOICE_IDLE) {
        status = voice_message(voice);
    } else if (mouse_active) {
        status = linked ? "Mouse active  /  A left, B right" : "Pair Codex Air Remote in Windows";
    } else {
        status = mouse_message;
    }
    update_label(status_label, status);
    if (mouse_active) lv_obj_add_state(gyro_button, LV_STATE_CHECKED);
    else lv_obj_remove_state(gyro_button, LV_STATE_CHECKED);
    if (recording_mode) lv_obj_add_state(voice_button, LV_STATE_CHECKED);
    else lv_obj_remove_state(voice_button, LV_STATE_CHECKED);
    if (recording_mode || !mouse_ready || !ble_ready) lv_obj_add_state(gyro_button, LV_STATE_DISABLED);
    else lv_obj_remove_state(gyro_button, LV_STATE_DISABLED);
    if (mouse_active || recording_mode || !voice_ready) lv_obj_add_state(voice_button, LV_STATE_DISABLED);
    else lv_obj_remove_state(voice_button, LV_STATE_DISABLED);

    update_label(a_hint, mouse_active ? "Left click" : recording_mode ? "Send" : "");
    update_label(b_hint, mouse_active ? "Right click" : recording_mode ? "Cancel" : "");
    bool mouse_controls = mouse_active && linked && mouse_calibrated();
    if (mouse_controls || voice == VOICE_RECORDING) lv_obj_remove_state(a_button, LV_STATE_DISABLED);
    else lv_obj_add_state(a_button, LV_STATE_DISABLED);
    if (mouse_controls || voice == VOICE_RECORDING || voice == VOICE_CONNECTING) {
        lv_obj_remove_state(b_button, LV_STATE_DISABLED);
    } else {
        lv_obj_add_state(b_button, LV_STATE_DISABLED);
    }

    /* Keep the panel bright: at the old idle level a dark UI reads as "dead".
     * Full brightness while the user interacts, 60% once it has been idle for
     * 25 s, and always full for the first 5 s after boot. The standby page has
     * its own (dimmer) level; see enter_standby(). */
    static uint32_t boot_tick;
    uint32_t now = lv_tick_get();
    if (boot_tick == 0) boot_tick = now;
    bool active = mouse_active || recording_mode || lv_tick_elaps(last_interaction) < 25000;
    int requested = (active || now - boot_tick < 5000) ? UI_BRIGHTNESS_ACTIVE : UI_BRIGHTNESS_IDLE;
    apply_brightness(requested);
}

static lv_obj_t *make_button(lv_obj_t *parent, int x, int y, uint32_t color)
{
    lv_obj_t *button = lv_button_create(parent);
    lv_obj_set_size(button, 150, 112);
    lv_obj_align(button, LV_ALIGN_TOP_LEFT, x, y);
    lv_obj_set_style_radius(button, 19, 0);
    lv_obj_set_style_bg_color(button, lv_color_hex(0x182638), 0);
    lv_obj_set_style_bg_color(button, lv_color_hex(color), LV_STATE_CHECKED);
    lv_obj_set_style_bg_color(button, lv_color_hex(0x405777), LV_STATE_PRESSED);
    lv_obj_set_style_opa(button, LV_OPA_50, LV_STATE_DISABLED);
    lv_obj_set_style_shadow_width(button, 0, 0);
    return button;
}

static lv_obj_t *button_caption(lv_obj_t *button, const char *text)
{
    lv_obj_t *label = lv_label_create(button);
    lv_label_set_text(label, text);
    lv_obj_set_style_text_font(label, &lv_font_montserrat_20, 0);
    lv_obj_set_style_text_color(label, lv_color_white(), 0);
    lv_obj_align(label, LV_ALIGN_BOTTOM_MID, 0, -12);
    return label;
}

static void glyph_line(lv_obj_t *glyph, const lv_point_precise_t *points, uint32_t count)
{
    lv_obj_t *line = lv_line_create(glyph);
    lv_obj_set_clickable(line, false);
    lv_line_set_points(line, points, count);
    lv_obj_set_pos(line, 0, 0);
    lv_obj_set_style_line_color(line, lv_color_white(), 0);
    lv_obj_set_style_line_width(line, 3, 0);
    lv_obj_set_style_line_rounded(line, true, 0);
}

static void mode_icon(lv_obj_t *button, bool voice)
{
    lv_obj_t *glyph = lv_obj_create(button);
    lv_obj_remove_style_all(glyph);
    lv_obj_set_scrollable(glyph, false);
    lv_obj_set_clickable(glyph, false);
    lv_obj_set_size(glyph, 48, 46);
    lv_obj_align(glyph, LV_ALIGN_TOP_MID, 0, 12);

    lv_obj_t *shape = lv_obj_create(glyph);
    lv_obj_remove_style_all(shape);
    lv_obj_set_scrollable(shape, false);
    lv_obj_set_clickable(shape, false);
    lv_obj_set_style_radius(shape, LV_RADIUS_CIRCLE, 0);
    if (voice) {
        lv_obj_set_size(shape, 14, 25);
        lv_obj_set_pos(shape, 17, 2);
        lv_obj_set_style_bg_color(shape, lv_color_white(), 0);
        lv_obj_set_style_bg_opa(shape, LV_OPA_COVER, 0);
        static const lv_point_precise_t cradle[] = {{10, 13}, {10, 21}, {13, 28}, {18, 32},
                                                    {24, 33}, {30, 32}, {35, 28}, {38, 21}, {38, 13}};
        static const lv_point_precise_t stem[] = {{24, 33}, {24, 42}};
        static const lv_point_precise_t base[] = {{17, 42}, {31, 42}};
        glyph_line(glyph, cradle, sizeof(cradle) / sizeof(cradle[0]));
        glyph_line(glyph, stem, 2);
        glyph_line(glyph, base, 2);
    } else {
        lv_obj_set_size(shape, 34, 34);
        lv_obj_center(shape);
        lv_obj_set_style_border_width(shape, 3, 0);
        lv_obj_set_style_border_color(shape, lv_color_white(), 0);
        static const lv_point_precise_t horizontal[] = {{3, 23}, {45, 23}};
        static const lv_point_precise_t vertical[] = {{24, 2}, {24, 44}};
        glyph_line(glyph, horizontal, 2);
        glyph_line(glyph, vertical, 2);
    }
}

static void letter_icon(lv_obj_t *button, const char *letter)
{
    lv_obj_t *label = lv_label_create(button);
    lv_label_set_text(label, letter);
    lv_obj_set_style_text_font(label, &lv_font_montserrat_28, 0);
    lv_obj_set_style_text_color(label, lv_color_white(), 0);
    lv_obj_align(label, LV_ALIGN_TOP_MID, 0, 16);
}

void app_ui_set_capabilities(bool mouse, bool ble, bool voice)
{
    mouse_ready = mouse;
    ble_ready = ble;
    voice_ready = voice;
}

void app_ui_refresh_clock(void)
{
    clock_dirty = true;
    /* Called from the USB console task after AR1T/AR1Z: a host-side change is
     * activity too, and it must never be swallowed by a standby switch. */
    note_activity();
}

/* Standby clock glyphs are 90x128 px. LVGL allocates an A8 mask per glyph from
 * its own pool (about 11.5 KiB for a digit), which cannot fit next to the rest
 * of the UI. Send font draw buffers to the system heap instead: only a few KiB
 * are used while a big label is drawn, and the 20 KiB LVGL pool stays free.
 * 分配失败必须打日志：曾经两次出现“数字空白”都是这里的静默失败。 */
static void *font_draw_malloc(size_t size, lv_color_format_t color_format)
{
    void *buffer;
    size_t free_size;
    size_t largest;

    (void)color_format;
    buffer = heap_caps_malloc(size, MALLOC_CAP_8BIT);
    free_size = heap_caps_get_free_size(MALLOC_CAP_8BIT);
    largest = heap_caps_get_largest_free_block(MALLOC_CAP_8BIT);
    if (buffer == NULL) {
        mask_fail_count++;
        ESP_LOGE(TAG, "glyph mask %u B FAILED, free %u largest %u, failures %u", (unsigned)size,
                 (unsigned)free_size, (unsigned)largest, (unsigned)mask_fail_count);
    } else if (size >= 10240) {
        ESP_LOGI(TAG, "glyph mask %u B ok, free %u largest %u", (unsigned)size,
                 (unsigned)free_size, (unsigned)largest);
    }

    return buffer;
}

static void font_draw_free(void *buffer)
{
    heap_caps_free(buffer);
}

static void font_draw_buffers_to_heap(void)
{
    static lv_draw_buf_handlers_t handlers;
    lv_draw_buf_handlers_t *defaults = lv_draw_buf_get_font_handlers();
    if (defaults == NULL) return;
    handlers = *defaults;
    handlers.buf_malloc_cb = font_draw_malloc;
    handlers.buf_free_cb = font_draw_free;
    LV_GLOBAL_DEFAULT()->font_draw_buf_handlers = handlers;
    ESP_LOGI(TAG, "standby font masks: system heap");
}

bool app_ui_init(lv_display_t *display)
{
    if (!board_lock(1000)) return false;
    font_draw_buffers_to_heap();
    lv_obj_t *screen = lv_display_get_screen_active(display);
    main_screen = screen;
    lv_obj_set_style_bg_color(screen, lv_color_hex(0x0b121d), 0);
    lv_obj_set_style_text_color(screen, lv_color_hex(0xc2cedb), 0);
    /* Top-left: date over a large clock, both fed by rtc_board in render().
     * Montserrat line heights are 30 px at size 28 and 52 px at size 48, so the
     * two lines with a 4 px gap end at y = 102, clear of the button grid. */
    date_label = lv_label_create(screen);
    lv_label_set_text(date_label, "----/--/--");
    lv_obj_set_style_text_font(date_label, &lv_font_montserrat_28, 0);
    lv_obj_set_style_text_color(date_label, lv_color_hex(0x8fa3b8), 0);
    lv_obj_align(date_label, LV_ALIGN_TOP_LEFT, 24, 16);
    clock_label = lv_label_create(screen);
    lv_label_set_text(clock_label, "--:--");
    lv_obj_set_style_text_font(clock_label, &lv_font_montserrat_48, 0);
    lv_obj_set_style_text_color(clock_label, lv_color_white(), 0);
    lv_obj_align(clock_label, LV_ALIGN_TOP_LEFT, 24, 50);

    /* Top-right cluster: BLE state icon to the left of the battery readout.
     * The battery label gets a fixed, wider-than-any-text width so a change
     * from "100%" to "9%" can never shift it under the icon. */
    battery_label = lv_label_create(screen);
    lv_obj_set_width(battery_label, 110);
    lv_obj_set_style_text_align(battery_label, LV_TEXT_ALIGN_RIGHT, 0);
    lv_obj_set_style_text_font(battery_label, &lv_font_montserrat_20, 0);
    lv_obj_align(battery_label, LV_ALIGN_TOP_RIGHT, -24, 22);
    bt_label = lv_label_create(screen);
    lv_label_set_text(bt_label, LV_SYMBOL_BLUETOOTH);
    lv_obj_set_style_text_font(bt_label, &lv_font_montserrat_20, 0);
    lv_obj_set_style_text_color(bt_label, lv_color_hex(0x55606e), 0);
    lv_obj_align_to(bt_label, battery_label, LV_ALIGN_OUT_LEFT_MID, -8, 0);

    /* 480 x 480 AMOLED: two 150 px columns centred with a 96 px gutter. The
     * grid moved down now that the BLE text line is gone. */
    voice_button = make_button(screen, 42, 150, 0x844351);
    gyro_button = make_button(screen, 288, 150, 0x266e84);
    a_button = make_button(screen, 42, 300, 0x266e84);
    b_button = make_button(screen, 288, 300, 0x844351);
    mode_icon(voice_button, true);
    mode_icon(gyro_button, false);
    button_caption(voice_button, "Voice");
    button_caption(gyro_button, "Gyro");
    letter_icon(a_button, "A");
    letter_icon(b_button, "B");
    a_hint = button_caption(a_button, "");
    b_hint = button_caption(b_button, "");

    lv_obj_set_scrollable(screen, false);
    lv_obj_set_press_lock(a_button, true);
    lv_obj_set_press_lock(b_button, true);
    lv_obj_add_event_cb(voice_button, voice_clicked, LV_EVENT_SHORT_CLICKED, NULL);
    lv_obj_add_event_cb(gyro_button, mouse_clicked, LV_EVENT_SHORT_CLICKED, NULL);
    lv_obj_add_event_cb(a_button, action_touch, LV_EVENT_ALL, NULL);
    lv_obj_add_event_cb(b_button, action_touch, LV_EVENT_ALL, NULL);
    status_label = lv_label_create(screen);
    lv_obj_set_width(status_label, 420);
    lv_obj_set_style_text_align(status_label, LV_TEXT_ALIGN_CENTER, 0);
    lv_label_set_long_mode(status_label, LV_LABEL_LONG_WRAP);
    lv_obj_align(status_label, LV_ALIGN_TOP_MID, 0, 416);

    /* Calibration popup, hidden until Gyro needs to say something. A plain
     * object on purpose: lv_msgbox runs its own event loop and would swallow
     * the touches the user needs for A/B while calibrating. */
    hint_panel = lv_obj_create(screen);
    lv_obj_set_size(hint_panel, 300, 120);
    lv_obj_center(hint_panel);
    lv_obj_set_style_bg_color(hint_panel, lv_color_hex(0x101a26), 0);
    lv_obj_set_style_bg_opa(hint_panel, LV_OPA_80, 0);
    lv_obj_set_style_radius(hint_panel, 18, 0);
    lv_obj_set_style_border_width(hint_panel, 0, 0);
    lv_obj_set_style_shadow_width(hint_panel, 0, 0);
    lv_obj_set_style_pad_all(hint_panel, 16, 0);
    lv_obj_set_clickable(hint_panel, false);
    lv_obj_set_scrollable(hint_panel, false);
    hint_label = lv_label_create(hint_panel);
    lv_obj_set_width(hint_label, 260);
    lv_label_set_long_mode(hint_label, LV_LABEL_LONG_WRAP);
    lv_obj_set_style_text_align(hint_label, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_set_style_text_font(hint_label, &lv_font_montserrat_20, 0);
    lv_obj_set_style_text_color(hint_label, lv_color_white(), 0);
    lv_obj_center(hint_label);
    lv_obj_set_hidden(hint_panel, true);

    /* Boot-time diagnostic: how much of the LVGL heap the UI actually needs. */
    lv_mem_monitor_t mon;
    lv_mem_monitor(&mon);
    ESP_LOGI(TAG, "lvgl mem: total=%u free=%u max_used=%u biggest=%u frag=%u%%",
             (unsigned)mon.total_size, (unsigned)mon.free_size, (unsigned)mon.max_used,
             (unsigned)mon.free_biggest_size, (unsigned)mon.frag_pct);
    uint32_t free_before = mon.free_size;

    /* Standby page: opaque black, topmost and clickable, so a wake tap lands on
     * it and never on a button underneath. Created once and only shown/hidden,
     * so entering and leaving standby neither rebuilds nor reallocates the UI. */
    standby_page = lv_obj_create(screen);
    lv_obj_remove_style_all(standby_page);
    lv_obj_set_size(standby_page, LV_PCT(100), LV_PCT(100));
    lv_obj_set_pos(standby_page, 0, 0);
    lv_obj_set_style_bg_color(standby_page, lv_color_black(), 0);
    lv_obj_set_style_bg_opa(standby_page, LV_OPA_COVER, 0);
    lv_obj_set_scrollable(standby_page, false);
    lv_obj_set_clickable(standby_page, true);
    /* Clock row: five fixed cells so the time always spans 450 px and the
     * digits cannot shift while the minutes change. */
    int32_t screen_h = lv_display_get_vertical_resolution(display);
    int32_t row_h = lv_font_get_line_height(&ui_font_standby_160);
    int32_t sec_h = lv_font_get_line_height(&lv_font_montserrat_48);
    int32_t block_h = row_h + STANDBY_SEC_GAP + sec_h;
    int32_t block_top = (screen_h - block_h) / 2;
    standby_row = lv_obj_create(standby_page);
    lv_obj_remove_style_all(standby_row);
    lv_obj_set_size(standby_row, STANDBY_DIGIT_W * 4 + STANDBY_COLON_W, row_h);
    lv_obj_align(standby_row, LV_ALIGN_TOP_MID, 0, block_top);
    lv_obj_set_scrollable(standby_row, false);
    lv_obj_set_clickable(standby_row, false);
    for (int i = 0; i < 5; i++) {
        standby_cell_img[i] = lv_image_create(standby_row);
        lv_obj_set_style_image_recolor(standby_cell_img[i], lv_color_white(), 0);
        lv_obj_set_style_image_recolor_opa(standby_cell_img[i], LV_OPA_COVER, 0);
        standby_set_glyph(i, standby_cell_char[i]);
    }
    /* 秒单独一行，用现成的 montserrat_48（不新增字体文件），水平居中在第一行正下方。 */
    standby_sec_label = lv_label_create(standby_page);
    lv_label_set_text(standby_sec_label, "00");
    lv_obj_set_style_text_font(standby_sec_label, &lv_font_montserrat_48, 0);
    lv_obj_set_style_text_color(standby_sec_label, lv_color_white(), 0);
    lv_obj_align(standby_sec_label, LV_ALIGN_TOP_MID, 0, block_top + row_h + STANDBY_SEC_GAP);
    /* 右上角电量：直接把主界面那个电量标签挂到待机页上（同一个控件、同一套
     * AXP2101 读数与图标刷新、同一边距），本页没有自己的轮询定时器；
     * 离开待机时再挂回主屏幕，见 leave_standby()。 */

    /* One callback on the input device sees every touch, whichever object it
     * hits; that is the phone-wide "touch = interaction" reset point. */
    for (lv_indev_t *indev = lv_indev_get_next(NULL); indev; indev = lv_indev_get_next(indev)) {
        if (!touch_indev && lv_indev_get_type(indev) == LV_INDEV_TYPE_POINTER) {
            touch_indev = indev;
            lv_indev_add_event_cb(indev, touch_pressed, LV_EVENT_PRESSED, NULL);
        }
    }
    if (!touch_indev) ESP_LOGW(TAG, "no pointer input device: standby wake by touch disabled");

    last_interaction = lv_tick_get();
    last_activity = last_interaction;
    lv_timer_create(render, 125, NULL);
    render(NULL);
    /* 侧边第三键（KEY，GPIO10）：短按/长按都只回调一次，回调里只置请求位，
     * 真正的切页由 render() 在 LVGL 上下文完成。 */
    app_key_set_press_cb(key_short_press);
    if (app_key_init() != ESP_OK) {
        ESP_LOGW(TAG, "third key unavailable, standby stays touch/idle only");
    }
    /* 待机数字资源自检（只在开机做一次）：度量、尺寸、非零像素三项都要过，
     * 结果每秒随待机日志打印，避免再出现“看起来有、其实没画”的误判。 */
    standby_glyph_pixels_ok = standby_font_check();
    /* The standby clock face is a 160 px Montserrat subset whose glyph bitmaps
     * live in rodata; only the six page objects cost LVGL heap. */
    lv_mem_monitor(&mon);
    ESP_LOGI(TAG, "lvgl mem +standby page: free=%u biggest=%u delta=%u B",
             (unsigned)mon.free_size, (unsigned)mon.free_biggest_size,
             (unsigned)(free_before - mon.free_size));
    board_unlock();
    return true;
}

bool app_ui_standby_active(void)
{
    return standby_active;
}

void app_ui_standby_tap(void)
{
    standby_tap_request = true;
}

void app_ui_debug_click(char which)
{
    debug_click_request = which;
}

