#include "provision.h"

#include <errno.h>
#include <stdio.h>
#include <stdatomic.h>
#include <stdlib.h>
#include <string.h>
#include "app_busy.h"
#include "app_ui.h"
#include "driver/usb_serial_jtag.h"
#include "driver/usb_serial_jtag_vfs.h"
#include "esp_check.h"
#include "esp_mac.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "nvs.h"
#include "rtc_board.h"

static const char *TAG = "usb_config";
static const char *KEY = "wifi";
static atomic_uint readiness;
static atomic_bool board_initialized;

void provision_report_board(unsigned flags)
{
    atomic_store(&readiness, flags);
    atomic_store(&board_initialized, true);
}

static int hex_digit(char c)
{
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    return -1;
}

static bool decode(const char *text, uint8_t *value, size_t capacity, size_t *bytes)
{
    if (strcmp(text, "-") == 0) {
        *bytes = 0;
        return true;
    }
    size_t length = strlen(text);
    if (length % 2 || length > capacity * 2) return false;
    *bytes = length / 2;
    for (size_t i = 0; i < *bytes; i++) {
        int hi = hex_digit(text[2*i]), lo = hex_digit(text[2*i+1]);
        if (hi < 0 || lo < 0 || (hi == 0 && lo == 0)) return false;
        value[i] = (hi << 4) | lo;
    }
    return true;
}

static void set_wifi(char *command)
{
    char *pass = strchr(command, ' ');
    if (!pass) {
        puts("AR1 WIFI INVALID");
        return;
    }
    *pass++ = 0;
    wifi_sta_config_t config = {0};
    size_t ssid_len, pass_len;
    if (!decode(command, config.ssid, sizeof(config.ssid), &ssid_len) || ssid_len == 0 ||
        !decode(pass, config.password, sizeof(config.password), &pass_len) ||
        (pass_len > 0 && pass_len < 8)) {
        puts("AR1 WIFI INVALID");
        return;
    }
    config.threshold.authmode = pass_len ? WIFI_AUTH_WPA2_PSK : WIFI_AUTH_OPEN;
    config.pmf_cfg.capable = true;
    nvs_handle_t handle;
    esp_err_t err = nvs_open("airremote", NVS_READWRITE, &handle);
    if (err == ESP_OK) {
        err = nvs_set_blob(handle, KEY, &config, sizeof(config));
        if (err == ESP_OK) err = nvs_commit(handle);
        nvs_close(handle);
    }
    puts(err == ESP_OK ? "AR1 WIFI OK" : "AR1 WIFI STORE FAILED");
}

static void set_time(const char *text)
{
    /* Strict decimal parse: no sign, no trailing garbage, no overflow. */
    if (!text[0] || text[0] == '-' || text[0] == '+') {
        puts("AR1T ERR");
        return;
    }
    char *end = NULL;
    errno = 0;
    long long value = strtoll(text, &end, 10);
    if (errno != 0 || end == text || *end != 0) {
        puts("AR1T ERR");
        return;
    }
    /* Writes the system clock and the battery-backed RTC; the UI repaints on
     * its next 125 ms tick so the screen shows the new time at once. The busy
     * hold keeps a standby switch from running inside the external time set. */
    app_busy_acquire(APP_BUSY_CONSOLE);
    esp_err_t err = rtc_board_set_unix((int64_t)value);
    app_busy_release(APP_BUSY_CONSOLE);
    if (err != ESP_OK) {
        puts("AR1T ERR");
        return;
    }
    app_ui_refresh_clock();
    printf("AR1T OK %lld\n", value);
}

static void set_timezone(const char *text)
{
    /* Minutes east of UTC, e.g. 480 for UTC+8. Optional leading '-', no '+',
     * no trailing garbage; the range guard lives in rtc_board as well. */
    if (!text[0] || text[0] == '+') {
        puts("AR1Z ERR");
        return;
    }
    char *end = NULL;
    errno = 0;
    long value = strtol(text, &end, 10);
    if (errno != 0 || end == text || *end != 0 || value < -720 || value > 840) {
        puts("AR1Z ERR");
        return;
    }
    app_busy_acquire(APP_BUSY_CONSOLE);
    esp_err_t err = rtc_board_set_tz_minutes((int)value);
    app_busy_release(APP_BUSY_CONSOLE);
    if (err != ESP_OK) {
        puts("AR1Z ERR");
        return;
    }
    app_ui_refresh_clock();
    printf("AR1Z OK %ld\n", value);
}

#if APP_UI_STANDBY_TEST_HOOK
/* TEMP: the standby page is woken by a touch, which no script can produce, so
 * the console reports the state and plays back the same input-device press the
 * touch panel would deliver (see app_ui_standby_tap). */
static void standby_status(void)
{
    printf("AR1 STANDBY %d\n", app_ui_standby_active() ? 1 : 0);
}

static void standby_tap(void)
{
    app_ui_standby_tap();
    puts("AR1 STANDBY TAP");
}

/* Play the click a finger would make on one of the mode buttons, for tests
 * that need the gyro (and its calibration popup) without a hand on the panel. */
static void standby_button(const char *name)
{
    if (strcmp(name, "GYRO") == 0) {
        app_ui_debug_click('g');
        puts("AR1 BUTTON GYRO");
    } else if (strcmp(name, "VOICE") == 0) {
        app_ui_debug_click('v');
        puts("AR1 BUTTON VOICE");
    } else {
        puts("AR1 BUTTON ERR");
    }
}
#endif

static void serial_task(void *unused)
{
    char line[220];
    size_t length = 0;
    bool overflow = false;
    for (;;) {
        uint8_t input[64];
        int count = usb_serial_jtag_read_bytes(input, sizeof(input), pdMS_TO_TICKS(100));
        for (int i = 0; i < count; i++) {
            char ch = input[i];
            if (ch == '\r') continue;
            if (ch == '\n') {
                line[length] = 0;
                if (!overflow && strcmp(line, "AR1?") == 0 && atomic_load(&board_initialized)) {
                    uint8_t mac[6] = {0};
                    esp_read_mac(mac, ESP_MAC_BT);
                    printf("AR1 READY %u %02x%02x%02x%02x%02x%02x\n", atomic_load(&readiness),
                           mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
                }
                if (!overflow && strncmp(line, "AR1W ", 5) == 0) set_wifi(line + 5);
                if (!overflow && strncmp(line, "AR1T ", 5) == 0) set_time(line + 5);
                if (!overflow && strncmp(line, "AR1Z ", 5) == 0) set_timezone(line + 5);
#if APP_UI_STANDBY_TEST_HOOK
                if (!overflow && strcmp(line, "AR1S") == 0) standby_status();
                if (!overflow && strcmp(line, "AR1S TAP") == 0) standby_tap();
                if (!overflow && strncmp(line, "AR1B ", 5) == 0) standby_button(line + 5);
#endif
                length = 0;
                overflow = false;
                memset(line, 0, sizeof(line));
            } else if (length < sizeof(line) - 1) {
                line[length++] = ch;
            } else {
                overflow = true;
            }
        }
    }
}

esp_err_t provision_start(void)
{
    usb_serial_jtag_driver_config_t config = {.tx_buffer_size = 256, .rx_buffer_size = 512};
    ESP_RETURN_ON_ERROR(usb_serial_jtag_driver_install(&config), TAG, "USB serial driver");
    usb_serial_jtag_vfs_use_driver();
    return xTaskCreate(serial_task, "usb_config", 4096, NULL, 4, NULL) == pdPASS ? ESP_OK : ESP_ERR_NO_MEM;
}

esp_err_t provision_read(wifi_config_t *config)
{
    memset(config, 0, sizeof(*config));
    nvs_handle_t handle;
    esp_err_t err = nvs_open("airremote", NVS_READONLY, &handle);
    if (err != ESP_OK) return err;
    size_t length = sizeof(config->sta);
    err = nvs_get_blob(handle, KEY, &config->sta, &length);
    nvs_close(handle);
    if (err != ESP_OK) return err;
    return length == sizeof(config->sta) && config->sta.ssid[0] ? ESP_OK : ESP_ERR_INVALID_SIZE;
}


