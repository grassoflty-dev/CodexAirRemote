#include "provision.h"

#include <stdio.h>
#include <stdatomic.h>
#include <stdlib.h>
#include <string.h>
#include "driver/usb_serial_jtag.h"
#include "driver/usb_serial_jtag_vfs.h"
#include "esp_check.h"
#include "esp_mac.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "nvs.h"
/* Serial voice trigger; declared locally to keep app_voice independent. */
esp_err_t voice_start(void);

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
                /* TEMP: start a voice session over USB for memory/protocol
                 * testing while the touch panel is not being operated. */
                if (!overflow && strcmp(line, "AR1V") == 0) {
                    printf("AR1 VOICE %s\n", voice_start() == ESP_OK ? "STARTED" : "BUSY");
                }
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


