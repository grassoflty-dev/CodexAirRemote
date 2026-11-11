#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

/*
 * On-board PCF85063ATL real-time clock (I2C 0x51, on the shared I2C0 bus with
 * the AXP2101 PMU and the CST9217 touch controller).
 *
 * The chip only stores a plain wall clock, so the firmware keeps it in *local*
 * time (UTC+8, see rtc_board.c) while the system clock (time()) stays UTC.
 */

/* Add the RTC to the shared bus and start its oscillator. Must run after
 * board_bus_init(); returns an error (and leaves the label at "--:--") when the
 * chip does not answer. */
esp_err_t rtc_board_init(void);

/* True when the RTC answered on the bus during rtc_board_init(). */
bool rtc_board_present(void);

/* Write "HH:MM" (24 h) into out; "--:--" while no valid time source exists. */
void rtc_board_time_text(char *out, size_t size);

/* Write "YYYY/MM/DD" into out; "----/--/--" while no valid time source exists. */
void rtc_board_date_text(char *out, size_t size);

/* Apply a UTC unix timestamp: stores it in the RTC backup domain (so the clock
 * keeps running across power-off) and in the system clock (so time() agrees). */
esp_err_t rtc_board_set_unix(int64_t unix_seconds);

#ifdef __cplusplus
}
#endif
