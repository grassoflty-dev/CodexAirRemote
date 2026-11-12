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
 * The chip stores UTC; the display time zone is a separate offset in minutes
 * (default UTC+8) that the host sets with AR1Z and that survives a reboot in
 * NVS. All time-zone math lives in rtc_board.c.
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

/* Current local second (0..59), or -1 while no valid time source exists. */
int rtc_board_second(void);

/* Apply a UTC unix timestamp: stores it in the RTC backup domain (so the clock
 * keeps running across power-off) and in the system clock (so time() agrees). */
esp_err_t rtc_board_set_unix(int64_t unix_seconds);

/* Display offset in minutes east of UTC (480 = UTC+8, range -720..+840).
 * Persisted in NVS under `airremote_time`/`tz_min`. */
esp_err_t rtc_board_set_tz_minutes(int minutes);

/* Currently active display offset in minutes. */
int rtc_board_tz_minutes(void);

#ifdef __cplusplus
}
#endif
