#include <stdio.h>
#include <string.h>
#include "air_mouse.h"
#include "ble_mouse.h"
#include "bsp/esp-bsp.h"
#include "driver/i2c_master.h"
#include "esp_flash.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "nvs_flash.h"
#include "provision.h"
#include "voice.h"

static const char *TAG = "air_remote";
static lv_obj_t *ble_label, *battery_label, *status_label, *gyro_button, *voice_button;
static lv_obj_t *a_button, *b_button, *a_hint, *b_hint;
static i2c_master_dev_handle_t pmu;
static bool mouse_active, mouse_ready, voice_ready, ble_ready;
static const char *mouse_message = "Tap a mode to begin";
static uint32_t last_interaction, last_battery_update;
static int brightness = -1;

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
    default:                  return "Tap a mode to begin";
    }
}

static void mouse_clicked(lv_event_t *event)
{
    last_interaction = lv_tick_get();
    if (voice_busy(voice_state())) return;
    if (mouse_active) {
        mouse_stop();
        mouse_active = false;
        mouse_message = "Mouse stopped";
    } else if (mouse_ready && ble_ready && mouse_start() == ESP_OK) {
        mouse_active = true;
    } else {
        mouse_message = "Mouse hardware unavailable";
    }
}

static void voice_clicked(lv_event_t *event)
{
    last_interaction = lv_tick_get();
    if (mouse_active || voice_busy(voice_state())) return;
    mouse_message = voice_ready && voice_start() == ESP_OK ?
                    "Tap a mode to begin" : "PC voice unavailable";
}

static void action_touch(lv_event_t *event)
{
    lv_event_code_t code = lv_event_get_code(event);
    bool a = lv_event_get_target(event) == a_button;
    if (code == LV_EVENT_PRESSED || code == LV_EVENT_SHORT_CLICKED) last_interaction = lv_tick_get();
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
    if (!pmu) return -1;
    uint8_t reg = 0x00, status, percent;
    if (i2c_master_transmit_receive(pmu, &reg, 1, &status, 1, 12) != ESP_OK ||
        !(status & (1 << 3))) return -1;
    reg = 0xa4;
    if (i2c_master_transmit_receive(pmu, &reg, 1, &percent, 1, 12) != ESP_OK || percent > 100) return -1;
    return percent;
}

static void update_label(lv_obj_t *label, const char *value)
{
    if (strcmp(lv_label_get_text(label), value) != 0) lv_label_set_text(label, value);
}

static void render(lv_timer_t *timer)
{
    voice_state_t voice = voice_state();
    bool recording_mode = voice_busy(voice);
    bool linked = ble_mouse_connected();
    if (mouse_active && mouse_failed()) {
        mouse_active = false;
        mouse_message = "Calibration failed. Hold still and retry";
    }

    update_label(ble_label, linked ? "BLE connected" : "BLE ready to pair");
    if (!ble_ready) update_label(ble_label, "BLE unavailable");
    if (lv_tick_elaps(last_battery_update) >= 1000) {
        last_battery_update = lv_tick_get();
        int percent = battery_percent();
        if (percent >= 0) {
            lv_label_set_text_fmt(battery_label, LV_SYMBOL_BATTERY_FULL " %d%%", percent);
        } else {
            update_label(battery_label, LV_SYMBOL_BATTERY_EMPTY " --");
        }
    }

    const char *status = voice != VOICE_IDLE ? voice_message(voice) : mouse_message;
    if (mouse_active) {
        status = !mouse_calibrated() ? "Hold still to calibrate..." :
                 linked ? "Mouse active  /  A left, B right" : "Pair Codex Air Remote in Windows";
    } else if (!recording_mode && strcmp(mouse_message, "Tap a mode to begin") != 0) {
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

    int requested = mouse_active || recording_mode || lv_tick_elaps(last_interaction) < 25000 ? 70 : 24;
    if (requested != brightness && bsp_display_brightness_set(requested) == ESP_OK) brightness = requested;
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

static bool ui_init(lv_display_t *display)
{
    if (!bsp_display_lock(1000)) return false;
    lv_obj_t *screen = lv_display_get_screen_active(display);
    lv_obj_set_style_bg_color(screen, lv_color_hex(0x0b121d), 0);
    lv_obj_set_style_text_color(screen, lv_color_hex(0xc2cedb), 0);
    lv_obj_t *title = lv_label_create(screen);
    lv_label_set_text(title, "Codex Air Remote");
    lv_obj_set_style_text_font(title, &lv_font_montserrat_28, 0);
    lv_obj_set_style_text_color(title, lv_color_white(), 0);
    lv_obj_align(title, LV_ALIGN_TOP_LEFT, 24, 27);
    ble_label = lv_label_create(screen);
    lv_obj_align(ble_label, LV_ALIGN_TOP_LEFT, 25, 69);
    battery_label = lv_label_create(screen);
    lv_obj_align(battery_label, LV_ALIGN_TOP_RIGHT, -25, 69);
    voice_button = make_button(screen, 24, 106, 0x844351);
    gyro_button = make_button(screen, 194, 106, 0x266e84);
    a_button = make_button(screen, 24, 232, 0x266e84);
    b_button = make_button(screen, 194, 232, 0x844351);
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
    lv_obj_set_width(status_label, 308);
    lv_obj_set_style_text_align(status_label, LV_TEXT_ALIGN_CENTER, 0);
    lv_label_set_long_mode(status_label, LV_LABEL_LONG_WRAP);
    lv_obj_align(status_label, LV_ALIGN_TOP_MID, 0, 367);
    last_interaction = lv_tick_get();
    lv_timer_create(render, 125, NULL);
    render(NULL);
    bsp_display_unlock();
    return true;
}

void app_main(void)
{
    uint32_t flash_size = 0;
    esp_flash_get_size(NULL, &flash_size);
    ESP_LOGI(TAG, "Flash %lu bytes; PSRAM %u bytes free",
             (unsigned long)flash_size, (unsigned)heap_caps_get_free_size(MALLOC_CAP_SPIRAM));

    esp_err_t nvs_status = nvs_flash_init();
    if (nvs_status == ESP_OK) {
        esp_err_t usb = provision_start();
        if (usb != ESP_OK) ESP_LOGE(TAG, "USB setup unavailable: %s", esp_err_to_name(usb));
    } else {
        ESP_LOGE(TAG, "NVS unavailable: %s", esp_err_to_name(nvs_status));
    }

    lv_display_t *display = bsp_display_start();
    if (!display) {
        provision_report_board(0);
        ESP_LOGE(TAG, "BSP could not start the panel and touch");
        return;
    }
    i2c_master_bus_handle_t bus = bsp_i2c_get_handle();
    const i2c_device_config_t battery = {
        .device_address = 0x34, .scl_speed_hz = 400000, .dev_addr_length = I2C_ADDR_BIT_LEN_7,
    };
    if (i2c_master_probe(bus, battery.device_address, 40) == ESP_OK) {
        i2c_master_bus_add_device(bus, &battery, &pmu);
    }
    mouse_ready = mouse_init() == ESP_OK;
    if (nvs_status == ESP_OK) {
        ble_ready = ble_mouse_init() == ESP_OK;
        voice_ready = voice_init() == ESP_OK;
    }
    bool ui_ready = ui_init(display);
    unsigned flags = (mouse_ready ? 1 : 0) | (ble_ready ? 2 : 0) | (voice_ready ? 4 : 0);
    provision_report_board(ui_ready ? flags : 0);
    ESP_LOGI(TAG, "AIRREMOTE UI READY; IMU=%d BLE=%d VOICE=%d PMU=%d",
             mouse_ready, ble_ready, voice_ready, pmu != NULL);
}
