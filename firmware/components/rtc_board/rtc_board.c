/* PCF85063ATL real-time clock on the ESP32-C6-Touch-AMOLED-2.16.
 *
 * The chip is a plain BCD wall clock wired to the shared I2C0 bus (SCL=7,
 * SDA=8) next to the AXP2101 PMU and the CST9217 touch controller. It is
 * backed by the VBAT cells ("CHG RTC" net on the schematic), so the time keeps
 * running while the board is powered off.
 *
 * The RTC stores **UTC**; the display time zone is a separate, host-set offset
 * in minutes (`AR1Z`), persisted in NVS, defaulting to UTC+8. This file is the
 * single place that knows both the register layout and the local conversion.
 */
#include "rtc_board.h"

#include <stdio.h>
#include <string.h>
#include <sys/time.h>
#include <time.h>

#include "board.h"
#include "driver/i2c_master.h"
#include "esp_log.h"
#include "nvs.h"

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

/* Display time zone: minutes east of UTC, more negative or western zones kept
 * inside -12 h..+14 h. The default applies until the host sends AR1Z; the value
 * is persisted in NVS so a reboot keeps the user's choice. */
#define RTC_TZ_DEFAULT_MIN 480 /* UTC+8 */
#define RTC_TZ_MIN (-720)
#define RTC_TZ_MAX 840
#define RTC_NVS_NAMESPACE "airremote_time"
#define RTC_NVS_TZ_KEY "tz_min"

static i2c_master_dev_handle_t s_rtc;
static bool s_present;
static int s_tz_minutes = RTC_TZ_DEFAULT_MIN;

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
 * (year since 1900, month 0..11). The values are UTC, matching what AR1T
 * writes; the display offset is applied later in current_local(). */
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

/* Days since 1970-01-01 for a civil date (proleptic Gregorian, Hinnant's
 * algorithm). newlib ships no timegm(), and this keeps the UTC conversion
 * independent of the process time zone env var. */
static int64_t days_from_civil(int year, int month, int day)
{
    int y = year - (month <= 2);
    int era = (y >= 0 ? y : y - 399) / 400;
    int yoe = y - era * 400;
    int doy = (153 * (month + (month > 2 ? -3 : 9)) + 2) / 5 + day - 1;
    int doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    return (int64_t)era * 146097 + doe - 719468;
}

/* UTC epoch seconds for the register values (they are UTC on the wire). */
static int64_t unix_from_fields(const struct tm *value)
{
    int64_t days = days_from_civil(value->tm_year + 1900, value->tm_mon + 1, value->tm_mday);
    return days * 86400 + value->tm_hour * 3600 + value->tm_min * 60 + value->tm_sec;
}

/* Current UTC epoch: the system clock wins once anything (AR1T, SNTP in the
 * future) has set it, because it keeps running on esp_timer between reads and
 * never needs I2C; otherwise fall back to the battery-backed RTC. */
static bool current_utc(int64_t *unix_seconds)
{
    time_t ticks = time(NULL);
    if ((int64_t)ticks >= RTC_MIN_UNIX) {
        *unix_seconds = (int64_t)ticks;
        return true;
    }
    struct tm now;
    if (!s_present || read_fields(&now) != ESP_OK || !fields_valid(&now)) {
        return false;
    }
    *unix_seconds = unix_from_fields(&now);
    return *unix_seconds >= RTC_MIN_UNIX;
}

/* UTC + the configured offset, broken down for the display. */
static bool current_local(struct tm *out)
{
    int64_t utc = 0;
    if (!current_utc(&utc)) {
        return false;
    }
    time_t local = (time_t)(utc + (int64_t)s_tz_minutes * 60);
    gmtime_r(&local, out);
    return true;
}

/* Load the persisted display offset. Runs before the I2C probe so a missing RTC
 * still shows the host's chosen zone once the system clock is set. */
static void load_timezone(void)
{
    nvs_handle_t handle;
    int32_t minutes = 0;
    if (nvs_open(RTC_NVS_NAMESPACE, NVS_READONLY, &handle) != ESP_OK) {
        return;
    }
    esp_err_t err = nvs_get_i32(handle, RTC_NVS_TZ_KEY, &minutes);
    nvs_close(handle);
    if (err != ESP_OK) {
        /* Nothing stored yet: keep the built-in default. */
        return;
    }
    if (minutes < RTC_TZ_MIN || minutes > RTC_TZ_MAX) {
        ESP_LOGW(TAG, "ignoring stored tz %ld min, out of range",
                 (long)minutes);
        return;
    }
    s_tz_minutes = (int)minutes;
}

esp_err_t rtc_board_init(void)
{
    if (s_present) {
        return ESP_OK;
    }
    load_timezone();
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
    uint8_t control_1_now = 0;
    uint8_t seconds_now = 0;
    if (rtc_read(RTC_REG_CONTROL_1, &control_1_now, 1) != ESP_OK) control_1_now = 0xFF;
    if (rtc_read(RTC_REG_SECONDS, &seconds_now, 1) != ESP_OK) seconds_now = 0xFF;
    ESP_LOGI(TAG, "PCF85063A status: control_1=0x%02x (STOP=%d), seconds=0x%02x (OS=%d)",
             control_1_now, (control_1_now >> 5) & 1, seconds_now, (seconds_now >> 7) & 1);
    if (read_fields(&now) == ESP_OK && fields_valid(&now)) {
        int64_t utc = unix_from_fields(&now);
        time_t local = (time_t)(utc + (int64_t)s_tz_minutes * 60);
        struct tm shown;
        gmtime_r(&local, &shown);
        ESP_LOGI(TAG, "PCF85063A ready, RTC holds %04d-%02d-%02d %02d:%02d:%02d UTC, display %04d-%02d-%02d %02d:%02d:%02d (tz %+d min), control 0x%02x",
                 now.tm_year + 1900, now.tm_mon + 1, now.tm_mday, now.tm_hour, now.tm_min,
                 now.tm_sec, shown.tm_year + 1900, shown.tm_mon + 1, shown.tm_mday, shown.tm_hour,
                 shown.tm_min, shown.tm_sec, s_tz_minutes, control);
    } else {
        ESP_LOGW(TAG, "PCF85063A ready but its time is unset; send AR1T <unix> to set it");
    }
    return ESP_OK;
}

bool rtc_board_present(void)
{
    return s_present;
}

/* Current local wall time: system clock or RTC (both UTC) + the NVS offset. */
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
    if (!current_local(&now)) {
        snprintf(out, size, "--:--");
        return;
    }
    snprintf(out, size, "%02d:%02d", now.tm_hour, now.tm_min);
}

void rtc_board_date_text(char *out, size_t size)
{
    if (!out || size == 0) {
        return;
    }
    if (size < 11) {
        out[0] = 0;
        return;
    }
    struct tm now;
    if (!current_local(&now)) {
        snprintf(out, size, "----/--/--");
        return;
    }
    snprintf(out, size, "%04d/%02d/%02d", now.tm_year + 1900, now.tm_mon + 1, now.tm_mday);
}
/* PCF85063A holds UTC; the display offset is applied by current_local(). */
int rtc_board_second(void)
{
    struct tm now;

    if (!current_local(&now))
    {
        return -1;
    }

    return now.tm_sec;
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
    /* The register file holds UTC: the display offset is applied on read only,
     * so changing AR1Z never needs the time to be sent again. */
    struct tm when;
    time_t utc = (time_t)unix_seconds;
    gmtime_r(&utc, &when);
    esp_err_t err = write_fields(&when);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "cannot write the RTC: %s", esp_err_to_name(err));
        return err;
    }
    ESP_LOGI(TAG, "RTC set to %04d-%02d-%02d %02d:%02d:%02d UTC, unix %lld",
             when.tm_year + 1900, when.tm_mon + 1, when.tm_mday, when.tm_hour, when.tm_min,
             when.tm_sec, (long long)unix_seconds);
    /* 写完回读：确认寄存器真的写进去了，并确认 STOP/OS 没被置位（秒不动 = STOP=1）。 */
    struct tm check;
    uint8_t control_1_after = 0xFF;
    uint8_t seconds_after = 0xFF;
    if (rtc_read(RTC_REG_CONTROL_1, &control_1_after, 1) != ESP_OK) control_1_after = 0xFF;
    if (rtc_read(RTC_REG_SECONDS, &seconds_after, 1) != ESP_OK) seconds_after = 0xFF;
    if (read_fields(&check) == ESP_OK) {
        ESP_LOGI(TAG, "RTC readback %04d-%02d-%02d %02d:%02d:%02d UTC, control_1=0x%02x (STOP=%d), "
                 "seconds=0x%02x (OS=%d)", check.tm_year + 1900, check.tm_mon + 1, check.tm_mday,
                 check.tm_hour, check.tm_min, check.tm_sec, control_1_after,
                 (control_1_after >> 5) & 1, seconds_after, (seconds_after >> 7) & 1);
    } else {
        ESP_LOGE(TAG, "RTC readback failed, control_1=0x%02x", control_1_after);
    }
    return ESP_OK;
}

int rtc_board_tz_minutes(void)
{
    return s_tz_minutes;
}

esp_err_t rtc_board_set_tz_minutes(int minutes)
{
    if (minutes < RTC_TZ_MIN || minutes > RTC_TZ_MAX) {
        ESP_LOGW(TAG, "rejecting tz %d min, outside %d..%d", minutes, RTC_TZ_MIN, RTC_TZ_MAX);
        return ESP_ERR_INVALID_ARG;
    }
    nvs_handle_t handle;
    esp_err_t err = nvs_open(RTC_NVS_NAMESPACE, NVS_READWRITE, &handle);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "cannot open NVS for the time zone: %s", esp_err_to_name(err));
        return err;
    }
    err = nvs_set_i32(handle, RTC_NVS_TZ_KEY, minutes);
    if (err == ESP_OK) {
        err = nvs_commit(handle);
    }
    nvs_close(handle);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "cannot store the time zone: %s", esp_err_to_name(err));
        return err;
    }
    s_tz_minutes = minutes;
    struct tm shown;
    if (current_local(&shown)) {
        ESP_LOGI(TAG, "display tz set to %+d min, local now %04d-%02d-%02d %02d:%02d:%02d",
                 minutes, shown.tm_year + 1900, shown.tm_mon + 1, shown.tm_mday, shown.tm_hour,
                 shown.tm_min, shown.tm_sec);
    } else {
        ESP_LOGW(TAG, "display tz set to %+d min, but no valid time source yet", minutes);
    }
    return ESP_OK;
}
