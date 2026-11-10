#include <stdio.h>
#include <string.h>
#include "air_mouse.h"
#include "app_ui.h"
#include "ble_mouse.h"
#include "board.h"
#include "esp_flash.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "nvs_flash.h"
#include "provision.h"
#include "voice.h"

static const char *TAG = "air_remote";
static bool mouse_ready, voice_ready, ble_ready;

/* TEMP display bisect (remove when the panel issue is closed): bring up only
 * I2C/PMU, the panel and the UI, skipping NVS/USB provisioning, voice, IMU and
 * BLE, to find out whether the display path itself is broken or whether one of
 * the earlier init steps breaks it. */
#define AIRREMOTE_DISPLAY_ONLY 1

static void log_heap(const char *stage)
{
    ESP_LOGI(TAG, "heap after %-14s free=%u min=%u", stage,
             (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL),
             (unsigned)heap_caps_get_minimum_free_size(MALLOC_CAP_INTERNAL));
}

void app_main(void)
{
    uint32_t flash_size = 0;
    esp_flash_get_size(NULL, &flash_size);
    ESP_LOGI(TAG, "Flash %lu bytes; internal heap %u bytes free",
             (unsigned long)flash_size, (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL));
    log_heap("boot");
#if AIRREMOTE_DISPLAY_ONLY
    {
        esp_err_t bus = board_bus_init();
        ESP_LOGI(TAG, "bisect: bus %s", esp_err_to_name(bus));
        lv_display_t *display = board_display_start() == ESP_OK ? board_display() : NULL;
        if (!display) {
            ESP_LOGE(TAG, "bisect: panel did not start");
            return;
        }
        ESP_LOGI(TAG, "bisect: panel up, heap %u",
                 (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL));
        bool ok = app_ui_init(display);
        ESP_LOGI(TAG, "bisect: ui %d, heap %u", (int)ok,
                 (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL));
        return;
    }
#endif
    /* Extra verbose logs while debugging the WebSocket voice path. */
    esp_log_level_set("httpd_ws", ESP_LOG_DEBUG);
    esp_log_level_set("httpd_parse", ESP_LOG_DEBUG);
    esp_log_level_set("httpd_uri", ESP_LOG_DEBUG);

    esp_err_t nvs_status = nvs_flash_init();
    if (nvs_status == ESP_OK) {
        esp_err_t usb = provision_start();
        if (usb != ESP_OK) ESP_LOGE(TAG, "USB setup unavailable: %s", esp_err_to_name(usb));
    } else {
        ESP_LOGE(TAG, "NVS unavailable: %s", esp_err_to_name(nvs_status));
    }
    log_heap("nvs+usb");

    /* Allocate the long-lived voice PCM buffer from a fresh, unfragmented heap
     * before BLE and LVGL carve it up. The Wi-Fi stack itself is only brought
     * up during a voice session (see voice.c). */
    if (nvs_status == ESP_OK) {
        voice_ready = voice_init() == ESP_OK;
    }
    log_heap("voice-buffer");

    /* The ESP32-C6 has no PSRAM, so allocation order matters:
     * PCM buffer -> I2C/PMU -> IMU -> I2S audio -> LVGL panel -> BLE.
     * Audio DMA and the LVGL SPI draw buffer both need internal DMA-capable
     * blocks and must be taken before Bluedroid fragments that region; BLE is
     * the largest block and is released again during voice sessions. */
    esp_err_t bus_status = board_bus_init();
    if (bus_status != ESP_OK) ESP_LOGE(TAG, "I2C/PMU init failed: %s", esp_err_to_name(bus_status));
    log_heap("i2c+pmu");

    mouse_ready = bus_status == ESP_OK && mouse_init() == ESP_OK;
    log_heap("imu");

    if (board_audio_init() != ESP_OK) ESP_LOGW(TAG, "Audio codec unavailable");
    log_heap("audio");

    lv_display_t *display = NULL;
    if (bus_status == ESP_OK && board_display_start() == ESP_OK) {
        display = board_display();
    }
    if (!display) {
        provision_report_board(0);
        ESP_LOGE(TAG, "BSP could not start the panel and touch");
        return;
    }
    log_heap("display+lvgl");

    if (nvs_status == ESP_OK) {
        ble_ready = ble_mouse_init() == ESP_OK;
    }
    log_heap("ble");

    app_ui_set_capabilities(mouse_ready, ble_ready, voice_ready);
    bool ui_ready = app_ui_init(display);
    unsigned flags = (mouse_ready ? 1 : 0) | (ble_ready ? 2 : 0) | (voice_ready ? 4 : 0);
    provision_report_board(ui_ready ? flags : 0);
    ESP_LOGI(TAG, "AIRREMOTE UI READY; IMU=%d BLE=%d VOICE=%d PMIC=%d",
             mouse_ready, ble_ready, voice_ready, board_battery_connected());
    log_heap("ui");
}



