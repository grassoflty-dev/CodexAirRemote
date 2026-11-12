#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "driver/i2c_master.h"
#include "esp_codec_dev.h"
#include "esp_err.h"
#include "lvgl.h"

#ifdef __cplusplus
extern "C" {
#endif

/*
 * Board abstraction for the Waveshare ESP32-C6-Touch-AMOLED-2.16.
 *
 * Implemented in C++ on top of the vendored board support components
 * (bsp_port / bsp_app) and exposed as a plain C API for main/.
 */

/* Initialise I2C, AXP2101, AMOLED panel + CST9217 touch, the LVGL adapter and
 * the ES8311/ES7210 codec. Safe to call once from app_main(). */
esp_err_t board_init(void);

/* Split stages, used by app_main to order BLE ahead of the bigger UI buffers. */
esp_err_t board_bus_init(void);
esp_err_t board_display_start(void);
esp_err_t board_audio_init(void);

/* LVGL display created by board_init(), or NULL while unavailable. */
lv_display_t *board_display(void);

/* Screen orientation in 90 degree steps: 0/90/180/270, every step turns the
 * whole UI 90 degrees counter-clockwise. It is a display level rotation, so it
 * applies to both the normal page and the standby page at once and survives
 * page switches. RAM only: no NVS read or write, a power cycle is back at 0.
 * Returns the rotation that is actually applied. Call with the LVGL lock held
 * (app_ui calls it from the settings panel's button callback). */
int board_display_rotation_set(int degrees);
int board_display_rotation(void);

/* LVGL adapter lock (recursive use from tasks is not required). */
bool board_lock(int timeout_ms);
void board_unlock(void);

/* Shared I2C master bus, for the QMI8658 IMU. */
i2c_master_bus_handle_t board_i2c_bus(void);

/* AMOLED brightness, 0..100. Implemented with the SH8601 0x51 command. */
esp_err_t board_set_brightness(int percent);

/* AXP2101 battery state; percent is -1 when no battery is attached. */
bool board_battery_connected(void);
int board_battery_percent(void);


/* Microphone stream handle (16 kHz, stereo, 16 bit). */
esp_codec_dev_handle_t board_microphone(void);

#ifdef __cplusplus
}
#endif
