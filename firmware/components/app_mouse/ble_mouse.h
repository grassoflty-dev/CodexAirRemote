#pragma once

#include <stdbool.h>
#include <stdint.h>
#include "esp_err.h"

esp_err_t ble_mouse_init(void);
/* Release the Bluedroid host + BT controller so a voice session can use the
 * radio and the heap (BLE and Wi-Fi audio are mutually exclusive modes). */
esp_err_t ble_mouse_release(void);
esp_err_t ble_mouse_resume(void);
bool ble_mouse_connected(void);
unsigned ble_mouse_generation(void);
/* True once the host has enabled HID report notifications (first indication
 * accepted); reports are dropped and probes are throttled before that. */
bool ble_mouse_reports_ready(void);
bool ble_mouse_report(uint8_t buttons, int8_t x, int8_t y);
