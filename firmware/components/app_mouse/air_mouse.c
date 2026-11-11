#include "air_mouse.h"

#include <math.h>
#include <stdatomic.h>
#include "app_busy.h"
#include "ble_mouse.h"
#include "board.h"
#include "driver/i2c_master.h"
#include "esp_check.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/queue.h"
// Waveshare's header defines its own M_PI.
#undef M_PI
#include "qmi8658.h"

static const char *TAG = "air_mouse";
enum { SAMPLE_MS = 4, CALIBRATION_SAMPLES = 150 };
static const float GRAVITY = 9.80665f;
static const float START_RATE = 1.5f, STOP_RATE = 1.0f;
static const float LINEAR_GAIN = 11.0f, QUADRATIC_GAIN = 0.17f;
/* screen_normal is +Z into the back of the board, so "up" is -Z and the
 * two signs must stay in sync: flipping only one inverts the cursor. */
static const float HORIZONTAL_SIGN = -1.0f, VERTICAL_SIGN = -1.0f;

typedef struct { float x, y, z; } vec;
static const vec screen_right = {1, 0, 0};
static const vec screen_up = {0, 1, 0};

static qmi8658_dev_t imu;
static atomic_bool requested, calibrated, failed, held;
static bool available;
static atomic_uint requested_buttons, mode_generation;
static QueueHandle_t button_events;

static vec add(vec a, vec b) { return (vec){a.x+b.x, a.y+b.y, a.z+b.z}; }
static vec scale(vec a, float s) { return (vec){a.x*s, a.y*s, a.z*s}; }
static float dot(vec a, vec b) { return a.x*b.x + a.y*b.y + a.z*b.z; }
static vec cross(vec a, vec b)
{
    return (vec){a.y*b.z - a.z*b.y, a.z*b.x - a.x*b.z, a.x*b.y - a.y*b.x};
}
static vec unit(vec a) { return scale(a, 1.0f / sqrtf(dot(a, a))); }
static vec perpendicular(vec a, vec axis) { return add(a, scale(axis, -dot(a, axis))); }

static vec pitch_axis(vec gravity, vec prior)
{
    /* Roll-invariant horizontal axis: perpendicular to both gravity and the
     * board's own x axis. cross(gravity, screen_normal) rotated into the
     * fore/aft axis while the wrist rolled, which leaked horizontal motion into
     * dy (measured dy +1..+7 on "push right edge down"). */
    vec axis = perpendicular(screen_right, gravity);
    if (dot(axis, axis) < 0.04f) axis = perpendicular(prior, gravity);
    if (dot(axis, axis) < 0.04f) axis = perpendicular(screen_up, gravity);
    axis = unit(axis);
    return dot(prior, axis) < 0 ? scale(axis, -1) : axis;
}

static float speed(float rate, bool *moving)
{
    float magnitude = fabsf(rate);
    *moving = magnitude > (*moving ? STOP_RATE : START_RATE);
    if (!*moving) return 0;
    float useful = magnitude - STOP_RATE;
    return copysignf(LINEAR_GAIN * useful + QUADRATIC_GAIN * useful * useful, rate);
}

static int8_t report_delta(float motion)
{
    return (int8_t)fmaxf(-127, fminf(127, motion));
}

static void mouse_task(void *unused)
{
    bool running = false, release_pending = true;
    int64_t release_retry_at = 0;
    uint8_t sent_buttons = 0;
    bool moving_x = false, moving_y = false;
    unsigned known_connection = 0, known_mode = 0;
    int collected = 0, read_errors = 0;
    unsigned report_tick = 0;
    vec gravity = {0}, bias = {0}, sum_accel = {0}, sum_gyro = {0}, axis = {0};
    float filtered_x = 0, filtered_y = 0, dx = 0, dy = 0;
    int64_t sample_time = esp_timer_get_time(), calibration_started = sample_time;
    TickType_t wake = xTaskGetTickCount();

    for (;;) {
        vTaskDelayUntil(&wake, pdMS_TO_TICKS(SAMPLE_MS));
        int64_t now = esp_timer_get_time();
        bool connected = ble_mouse_connected();
        unsigned connection = ble_mouse_generation();
        if (!connected || known_connection != connection) {
            known_connection = connection;
            release_pending = true;
            release_retry_at = 0;
            sent_buttons = 0;
            atomic_store(&requested_buttons, 0);
            xQueueReset(button_events);
            dx = dy = 0;
        }
        /* The HID host has not necessarily subscribed to reports yet; wait for
         * the first successful indication instead of retrying every 4 ms. */
        if (connected && release_pending && now >= release_retry_at) {
            if (ble_mouse_report(0, 0, 0)) {
                release_pending = false;
                sent_buttons = 0;
            } else {
                release_retry_at = now + 500000;
            }
        }

        bool wanted = atomic_load(&requested);
        unsigned mode = atomic_load(&mode_generation);
        if (wanted != running || known_mode != mode) {
            known_mode = mode;
            running = wanted;
            if (qmi8658_enable_sensors(&imu, running ? QMI8658_ENABLE_ACCEL | QMI8658_ENABLE_GYRO : 0) != ESP_OK) {
                atomic_store(&failed, true);
                atomic_store(&requested, false);
            }
            collected = read_errors = 0;
            sum_accel = sum_gyro = (vec){0};
            filtered_x = filtered_y = dx = dy = 0;
            moving_x = moving_y = false;
            atomic_store(&requested_buttons, 0);
            xQueueReset(button_events);
            calibration_started = sample_time = now;
            atomic_store(&calibrated, false);
            release_pending = true;
            release_retry_at = 0;
        }
        if (!running) continue;

        bool ready = false;
        qmi8658_data_t sample;
        esp_err_t result = qmi8658_is_data_ready(&imu, &ready);
        if (result == ESP_OK && ready) result = qmi8658_read_sensor_data(&imu, &sample);
        if (result != ESP_OK) {
            if (++read_errors >= 10) {
                atomic_store(&failed, true);
                atomic_store(&requested, false);
            }
            continue;
        }
        read_errors = 0;
        if (!atomic_load(&calibrated) && now - calibration_started > 30000000) {
            ESP_LOGW(TAG, "IMU calibration timeout: keep the board still after tapping Gyro");
            atomic_store(&failed, true);
            atomic_store(&requested, false);
            continue;
        }
        if (ready) {
            float dt = fminf(0.04f, (now - sample_time) * 1e-6f);
            sample_time = now;
            vec accel = {sample.accelX, sample.accelY, sample.accelZ};
            vec gyro = {sample.gyroX, sample.gyroY, sample.gyroZ};
            float accel_mag = sqrtf(dot(accel, accel));
            if (!atomic_load(&calibrated)) {
                /* 1.0 m/s^2 is only ~10 % of g, but the sensor reads ~6.8 %
                 * high (10.47 vs 9.80665), which left almost no margin for a
                 * hand-held board. Scale the tolerance instead. */
                if (fabsf(accel_mag - GRAVITY) > 0.15f * GRAVITY || dot(gyro, gyro) > 64 ||
                    (collected && dot(unit(accel), unit(sum_accel)) < 0.999f)) {
                    collected = 0;
                    sum_accel = sum_gyro = (vec){0};
                    continue;
                }
                sum_accel = add(sum_accel, accel);
                sum_gyro = add(sum_gyro, gyro);
                if (++collected < CALIBRATION_SAMPLES) continue;
                bias = scale(sum_gyro, 1.0f / collected);
                gravity = unit(sum_accel);
                axis = pitch_axis(gravity, (vec){0});
                atomic_store(&calibrated, true);
                ESP_LOGI(TAG, "IMU calibrated after %d samples", collected);
            } else {
                gyro = add(gyro, scale(bias, -1));
                // The gravity vector is the part of the six-axis attitude used here.
                // Predict in body coordinates, then apply proportional gravity feedback.
                vec omega = scale(gyro, 0.0174532925f);
                float weight = fmaxf(0, 1 - fabsf(accel_mag - GRAVITY) / 2.0f);
                if (weight > 0) {
                    omega = add(omega, scale(cross(unit(accel), gravity), 3.5f * weight));
                }
                gravity = unit(add(gravity, scale(cross(gravity, omega), dt)));
                axis = pitch_axis(gravity, axis);
                float alpha = dt / (0.025f + dt);
                filtered_x += alpha * (HORIZONTAL_SIGN * dot(gyro, gravity) - filtered_x);
                filtered_y += alpha * (VERTICAL_SIGN * dot(gyro, axis) - filtered_y);
                if (connected && !release_pending) {
                    dx = fmaxf(-508, fminf(508, dx + speed(filtered_x, &moving_x) * dt));
                    dy = fmaxf(-508, fminf(508, dy + speed(filtered_y, &moving_y) * dt));
                }
            }
        }

        if (!connected || release_pending || !atomic_load(&calibrated)) continue;
        /* Before the host enables report notifications there is no point sending
         * (and the HID library would log an error per attempt); drop the
         * accumulated motion so the first real report does not jump. */
        if (!ble_mouse_reports_ready()) {
            dx = dy = 0;
            continue;
        }
        /* Safety net: if a press/release event was lost (queue reset racing a
         * touch, report failure during a link drop), re-assert the requested
         * state every ~2 s instead of leaving a button latched forever. */
        uint8_t buttons = sent_buttons;
        bool queued = xQueuePeek(button_events, &buttons, 0) == pdTRUE;
        bool button_event = queued;
        uint8_t requested_state = (uint8_t)atomic_load(&requested_buttons);
        if (!button_event && buttons != requested_state && (report_tick % 500) == 0) {
            buttons = requested_state;
            button_event = true;
        }
        if ((++report_tick % 2) == 0 || button_event) {
            int8_t x = report_delta(dx), y = report_delta(dy);
            if ((x || y || button_event) && atomic_load(&requested) && ble_mouse_report(buttons, x, y)) {
                dx -= x;
                dy -= y;
                sent_buttons = buttons;
                if (queued) xQueueReceive(button_events, &buttons, 0);
            }
        }
    }
}

esp_err_t mouse_init(void)
{
    i2c_master_bus_handle_t bus = board_i2c_bus();
    ESP_RETURN_ON_FALSE(bus, ESP_ERR_INVALID_STATE, TAG, "I2C bus is not ready");
    uint8_t address = QMI8658_ADDRESS_HIGH;
    if (i2c_master_probe(bus, address, 50) != ESP_OK) address = QMI8658_ADDRESS_LOW;
    ESP_RETURN_ON_ERROR(qmi8658_init(&imu, bus, address), TAG, "QMI8658");
    uint8_t id;
    ESP_RETURN_ON_ERROR(qmi8658_get_who_am_i(&imu, &id), TAG, "WHO_AM_I");
    ESP_RETURN_ON_FALSE(id == 0x05, ESP_ERR_NOT_FOUND, TAG, "IMU ID %02x", id);
    ESP_RETURN_ON_ERROR(qmi8658_write_register(&imu, 0x60, 0xb0), TAG, "reset");
    vTaskDelay(pdMS_TO_TICKS(20));
    ESP_RETURN_ON_ERROR(qmi8658_write_register(&imu, QMI8658_CTRL1, 0x60), TAG, "CTRL1");
    ESP_RETURN_ON_ERROR(qmi8658_set_accel_range(&imu, QMI8658_ACCEL_RANGE_4G), TAG, "accel range");
    ESP_RETURN_ON_ERROR(qmi8658_set_accel_odr(&imu, QMI8658_ACCEL_ODR_250HZ), TAG, "accel ODR");
    ESP_RETURN_ON_ERROR(qmi8658_set_gyro_range(&imu, QMI8658_GYRO_RANGE_512DPS), TAG, "gyro range");
    ESP_RETURN_ON_ERROR(qmi8658_set_gyro_odr(&imu, QMI8658_GYRO_ODR_250HZ), TAG, "gyro ODR");
    qmi8658_set_accel_unit_mps2(&imu, true);
    qmi8658_set_gyro_unit_dps(&imu, true);
    ESP_RETURN_ON_ERROR(qmi8658_enable_sensors(&imu, 0), TAG, "standby");
    button_events = xQueueCreate(16, sizeof(uint8_t));
    ESP_RETURN_ON_FALSE(button_events, ESP_ERR_NO_MEM, TAG, "Touch button queue");
    /* 4 KiB was tight: the task carries sensor samples, float pose math and
 * logging; an overflow corrupts the neighbouring heap block (observed as a
 * Store access fault around leaving Gyro mode). */
available = xTaskCreate(mouse_task, "air_mouse", 6144, NULL, 7, NULL) == pdPASS;
    if (!available) {
        vQueueDelete(button_events);
        button_events = NULL;
    }
    ESP_LOGI(TAG, "QMI8658 at 0x%02x, WHO_AM_I=0x%02x", address, id);
    return available ? ESP_OK : ESP_ERR_NO_MEM;
}

esp_err_t mouse_start(void)
{
    if (!available) return ESP_ERR_INVALID_STATE;
    atomic_store(&failed, false);
    atomic_store(&calibrated, false);
    atomic_fetch_add(&mode_generation, 1);
    atomic_store(&requested, true);
    /* The whole gyro runtime holds the idle timer: calibration, mouse mode and
     * the pose math all count as "the board is in use", so the standby page
     * never appears in the middle of it. mouse_stop() releases it, and
     * mouse_stop() is also what the UI calls for every failure the task
     * reports (failed flag, calibration timeout, queue overflow). The atomic
     * flag keeps acquire/release exactly paired even if stop runs twice. */
    if (!atomic_exchange(&held, true)) app_busy_acquire(APP_BUSY_GYRO);
    ESP_LOGI(TAG, "mouse mode on, calibrating");
    return ESP_OK;
}

void mouse_stop(void)
{
    atomic_store(&requested, false);
    atomic_store(&calibrated, false);
    atomic_store(&requested_buttons, 0);
    if (atomic_exchange(&held, false)) app_busy_release(APP_BUSY_GYRO);
}

void mouse_button(uint8_t button, bool pressed)
{
    if (!button_events) return;
    if (pressed && (!atomic_load(&requested) || !atomic_load(&calibrated) || !ble_mouse_connected())) return;
    unsigned previous = pressed ? atomic_fetch_or(&requested_buttons, button) :
                                  atomic_fetch_and(&requested_buttons, ~(unsigned)button);
    uint8_t current = pressed ? previous | button : previous & ~button;
    if (previous == current) return;
    if (xQueueSend(button_events, &current, 0) != pdTRUE) {
        // Stop and release on overflow instead of losing a button-up event.
        atomic_store(&failed, true);
        mouse_stop();
    }
}
bool mouse_calibrated(void) { return atomic_load(&calibrated); }
bool mouse_failed(void) { return atomic_load(&failed); }
