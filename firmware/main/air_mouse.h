#pragma once

#include <stdbool.h>
#include <stdint.h>
#include "esp_err.h"

esp_err_t mouse_init(void);
esp_err_t mouse_start(void);
void mouse_stop(void);
enum { MOUSE_LEFT = 1, MOUSE_RIGHT = 2 };
void mouse_button(uint8_t button, bool pressed);
bool mouse_calibrated(void);
bool mouse_failed(void);
