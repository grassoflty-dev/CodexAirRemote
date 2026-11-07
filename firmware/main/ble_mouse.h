#pragma once

#include <stdbool.h>
#include <stdint.h>
#include "esp_err.h"

esp_err_t ble_mouse_init(void);
bool ble_mouse_connected(void);
unsigned ble_mouse_generation(void);
bool ble_mouse_report(uint8_t buttons, int8_t x, int8_t y);
