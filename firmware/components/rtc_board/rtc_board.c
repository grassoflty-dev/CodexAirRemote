/* PCF85063ATL real-time clock on the ESP32-C6-Touch-AMOLED-2.16.
 *
 * The chip is a plain BCD wall clock wired to the shared I2C0 bus (SCL=7,
 * SDA=8) next to the AXP2101 PMU and the CST9217 touch controller. It is
 * backed by the VBAT cells ("CHG RTC" net on the schematic), so the time keeps
 * running while the board is powered off.
 *
 * This file is the single place that knows both the register layout and the
 * time zone: the RTC stores local time (UTC+9, Asia/Tokyo) while the system
 * clock (time()) stays UTC, and the two are converted here only.
 */
#include "rtc_board.h"

#include <stdio.h>
#include <string.h>
#include <sys/time.h>
#include <time.h>

#include "board.h"
#include "driver/i2c_master.h"
#include "esp_log.h"

static const char *TAG = "rtc";

/* Register map (PCF85063A datasheet rev. 4): 0x00 control_1, 0x01 control_2,
 * 0x02 offset, 0x03 RAM, 0x04..0x0A the BCD time registers. A single burst
 * write starting at 0x04 sets seconds..years, matching the Waveshare example's
 * pcf85063a_set_time_date(). */
#define RTC_ADDR 0x51
#define RTC_REG_CONTROL_1 0x00
#define RTC_REG_SECONDS 0x04
#define RTC_TIME_REGS 7

/* control_1: STOP (bit 5) and SR (bit 4) cleared so the oscillator runs and is
 * not reset; CAP_SEL (bit 0) = 1 selects 12.5 pF, the load capacitance the
 * board's own example firmware uses. */
#define RTC_CONTROL_1_RUN 0x01

#define RTC_I2C_TIMEOUT_MS 100
#define RTC_I2C_SPEED_HZ 400000

/* Validity window: the year register counts 00..99 with a 2000 offset, so the
 * firmware can represent 2000..2099 only. Anything before 2024 means the RTC
 * was never set (factory default or a dead backup cell). */
#define RTC_MIN_UNIX 1704067200LL /* 2024-01-01T00:00:00Z */
#define RTC_MAX_UNIX 4102444799LL /* 2099-12-31T23:59:59Z */
#define RTC_MIN_YEAR 2024

/* ESP-IDF's newlib has no time zone configured (TZ is unset and nothing calls
 * tzset()), so localtime_r() would return UTC. Converting with gmtime_r() on a
 * shifted epoch keeps the offset in one place instead of relying on env vars.
 *
 * The offset matches where the board lives: Asia/Tokyo (UTC+9, no DST). If the
 * board moves time zones this single constant is the only place to change. */
#define RTC_TZ_OFFSET_SEC (9 * 3600) /* UTC+9, Asia/Tokyo */

static i2c_master_dev_handle_t s_rtc;
static bool s_present;

static uint8_t to_bcd(int value)
{
    return (uint8_t)(((value / 10) << 4) | (value % 10));
}

static int from_bcd(uint8_t value)
{
    return (value >> 4) * 10 + (value & 0x0F);
}

static esp_err_t rtc_write(const uint8_t *data, size_t length)
{
    return i2c_master_transmit(s_rtc, data, length, RTC_I2C_TIMEOUT_MS);
}

static esp_err_t rtc_read(uint8_t reg, uint8_t *data, size_t length)
{
    return i2c_master_transmit_receive(s_rtc, &reg, 1, data, length, RTC_I2C_TIMEOUT_MS);
}

/* Read the seven time registers into a struct tm using the usual conventions
 * (year since 1900, month 0..11). The values are local time. */
static esp_err_t read_fields(struct tm *out)
{
    uint8_t regs[RTC_TIME_REGS];
    esp_err_t err = rtc_read(RTC_REG_SECONDS, regs, sizeof(regs));
    if (err != ESP_OK) {
        return err;
    }
    memset(out, 0, sizeof(*out));
    out->tm_sec = from_bcd(regs[0] & 0x7F);
    out->tm_min = from_bcd(regs[1] & 0x7F);
    out->tm_hour = from_bcd(regs[2] & 0x3F); /* 24-hour mode */
    out->tm_mday = from_bcd(regs[3] & 0x3F);
    out->tm_wday = from_bcd(regs[4] & 0x07);
    out->tm_mon = from_bcd(regs[5] & 0x1F) - 1;
    out->tm_year = 2000 + from_bcd(regs[6]) - 1900;
    return ESP_OK;
}

static esp_err_t write_fields(const struct tm *value)
{
    uint8_t regs[RTC_TIME_REGS + 1];
    regs[0] = RTC_REG_SECONDS;
    regs[1] = to_bcd(value->tm_sec);
    regs[2] = to_bcd(value->tm_min);
    regs[3] = to_bcd(value->tm_hour);
    regs[4] = to_bcd(value->tm_mday);
    regs[5] = to_bcd(value->tm_wday);
    regs[6] = to_bcd(value->tm_mon + 1);
    regs[7] = to_bcd((value->tm_year + 1900) % 100);
    return rtc_write(regs, sizeof(regs));
}

static bool fields_valid(const struct tm *value)
{
    return value->tm_year + 1900 >= RTC_MIN_YEAR && value->tm_mon >= 0 && value->tm_mon <= 11 &&
           value->tm_mday >= 1 && value->tm_mday <= 31 && value->tm_hour >= 0 &&
           value->tm_hour <= 23 && value->tm_min >= 0 && value->tm_min <= 59 &&
           value->tm_sec >= 0 && value->tm_sec <= 59;
}

esp_err_t rtc_board_init(void)
{
    if (s_present) {
        return ESP_OK;
    }
    i2c_master_bus_handle_t bus = board_i2c_bus();
    if (!bus) {
        return ESP_ERR_INVALID_STATE;
    }
    if (!s_rtc) {
        i2c_device_config_t config = {
            .dev_addr_length = I2C_ADDR_BIT_LEN_7,
            .device_address = RTC_ADDR,
            .scl_speed_hz = RTC_I2C_SPEED_HZ,
        };
        esp_err_t err = i2c_master_bus_add_device(bus, &config, &s_rtc);
        if (err != ESP_OK) {
            ESP_LOGE(TAG, "cannot add PCF85063A to I2C bus: %s", esp_err_to_name(err));
            s_rtc = NULL;
            return err;
        }
    }
    /* Reading control_1 doubles as a presence probe. */
    uint8_t control = 0;
    esp_err_t err = rtc_read(RTC_REG_CONTROL_1, &control, 1);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "no PCF85063A at 0x%02x (%s), clock stays RAM-only", RTC_ADDR,
                 esp_err_to_name(err));
        return err;
    }
    const uint8_t start[] = {RTC_REG_CONTROL_1, RTC_CONTROL_1_RUN};
    err = rtc_write(start, sizeof(start));
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "cannot start the RTC oscillator: %s", esp_err_to_name(err));
        return err;
    }
    s_present = true;

    struct tm now;
    if (read_fields(&now) == ESP_OK && fields_valid(&now)) {
        ESP_LOGI(TAG, "PCF85063A ready, RTC holds %04d-%02d-%02d %02d:%02d:%02d (UTC%+d, control 0x%02x)",
                 now.tm_year + 1900, now.tm_mon + 1, now.tm_mday, now.tm_hour, now.tm_min,
                 now.tm_sec, RTC_TZ_OFFSET_SEC / 3600, control);
    } else {
        ESP_LOGW(TAG, "PCF85063A ready but its time is unset; send AR1T <unix> to set it");
    }
    return ESP_OK;
}

bool rtc_board_present(void)
{
    return s_present;
}

void rtc_board_time_text(char *out, size_t size)
{
    if (!out || size == 0) {
        return;
    }
    if (size < 6) {
        out[0] = 0;
        return;
    }
    struct tm now;
    bool valid = false;
    /* The system clock wins once anything (AR1T, SNTP in the future) has set
     * it: it keeps running on esp_timer between reads and never needs I2C. */
    time_t ticks = time(NULL);
    if ((int64_t)ticks >= RTC_MIN_UNIX) {
        time_t local = ticks + RTC_TZ_OFFSET_SEC;
        gmtime_r(&local, &now);
        valid = true;
    } else if (s_present && read_fields(&now) == ESP_OK && fields_valid(&now)) {
        valid = true;
    }
    if (!valid) {
        snprintf(out, size, "--:--");
        return;
    }
    snprintf(out, size, "%02d:%02d", now.tm_hour, now.tm_min);
}

esp_err_t rtc_board_set_unix(int64_t unix_seconds)
{
    if (unix_seconds < RTC_MIN_UNIX || unix_seconds > RTC_MAX_UNIX) {
        ESP_LOGW(TAG, "rejecting unix %lld, outside 2024..2099", (long long)unix_seconds);
        return ESP_ERR_INVALID_ARG;
    }
    struct timeval tv = {.tv_sec = (time_t)unix_seconds, .tv_usec = 0};
    if (settimeofday(&tv, NULL) != 0) {
        ESP_LOGE(TAG, "settimeofday failed");
        return ESP_FAIL;
    }
    if (!s_present) {
        /* Keep the system clock (and therefore the UI) right until power-off;
         * the caller reports the missing backup separately. */
        ESP_LOGW(TAG, "no RTC to persist the time, system clock only");
        return ESP_ERR_INVALID_STATE;
    }
    time_t local = (time_t)unix_seconds + RTC_TZ_OFFSET_SEC;
    struct tm when;
    gmtime_r(&local, &when);
    esp_err_t err = write_fields(&when);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "cannot write the RTC: %s", esp_err_to_name(err));
        return err;
    }
    ESP_LOGI(TAG, "RTC set to %04d-%02d-%02d %02d:%02d:%02d local, unix %lld",
             when.tm_year + 1900, when.tm_mon + 1, when.tm_mday, when.tm_hour, when.tm_min,
             when.tm_sec, (long long)unix_seconds);
    return ESP_OK;
}
