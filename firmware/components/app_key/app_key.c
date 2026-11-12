/* 侧边第三个实体按键（KEY）的消抖与短按/长按判定。
 * 引脚取自 board_pins.h 的唯一来源 BOARD_KEY_BUTTON。 */
#include "app_key.h"

#include <stdbool.h>
#include <stdint.h>

#include "board_pins.h"
#include "driver/gpio.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#define KEY_POLL_MS 5
#define KEY_DEBOUNCE_US 25000
#define KEY_LONG_PRESS_US 1000000
#define KEY_LEVEL_DOWN 0

static const char *TAG = "app_key";
static app_key_press_cb_t s_callback;
static volatile bool s_pressed;
static bool s_started;

/* 每 5 ms 采一次电平，连续 25 ms 稳定才认一次翻转。每个按下周期最多回调一次：
 * 按住满 1 s 立即回调（长按），1 s 内松开则在松开时回调（短按）。 */
static void key_task(void *arg)
{
    int stable = gpio_get_level((gpio_num_t)BOARD_KEY_BUTTON);
    int candidate = stable;
    int64_t candidate_since = esp_timer_get_time();
    int64_t pressed_at = 0;
    bool fired = false;

    (void)arg;
    for (;;)
    {
        int64_t now;
        int level;

        vTaskDelay(pdMS_TO_TICKS(KEY_POLL_MS));
        now = esp_timer_get_time();
        level = gpio_get_level((gpio_num_t)BOARD_KEY_BUTTON);
        if (level != candidate)
        {
            candidate = level;
            candidate_since = now;
            continue;
        }
        if (candidate == stable || now - candidate_since < KEY_DEBOUNCE_US)
        {
            continue;
        }
        stable = candidate;
        if (stable == KEY_LEVEL_DOWN)
        {
            pressed_at = now;
            fired = false;
            s_pressed = true;
            ESP_LOGI(TAG, "key down (gpio %d)", BOARD_KEY_BUTTON);
            continue;
        }
        s_pressed = false;
        if (!fired)
        {
            ESP_LOGI(TAG, "key up, short press %lld ms", (long long)((now - pressed_at) / 1000));
            fired = true;
            if (s_callback)
            {
                s_callback();
            }
        }
        else
        {
            ESP_LOGI(TAG, "key up after long press %lld ms, no second trigger",
                     (long long)((now - pressed_at) / 1000));
        }
    }
}

esp_err_t app_key_init(void)
{
    gpio_config_t cfg = {0};
    esp_err_t err;

    if (s_started)
    {
        return ESP_OK;
    }
    cfg.pin_bit_mask = 1ULL << BOARD_KEY_BUTTON;
    cfg.mode = GPIO_MODE_INPUT;
    cfg.pull_up_en = GPIO_PULLUP_ONLY;
    cfg.pull_down_en = GPIO_PULLDOWN_DISABLE;
    cfg.intr_type = GPIO_INTR_DISABLE;
    err = gpio_config(&cfg);
    if (err != ESP_OK)
    {
        ESP_LOGE(TAG, "gpio_config(%d) failed: %s", BOARD_KEY_BUTTON, esp_err_to_name(err));
        return err;
    }
    if (xTaskCreate(key_task, "app_key", 3072, NULL, 3, NULL) != pdPASS)
    {
        return ESP_ERR_NO_MEM;
    }
    s_started = true;
    ESP_LOGI(TAG, "KEY button on gpio %d, idle level %d", BOARD_KEY_BUTTON,
             gpio_get_level((gpio_num_t)BOARD_KEY_BUTTON));
    return ESP_OK;
}

void app_key_set_press_cb(app_key_press_cb_t callback)
{
    s_callback = callback;
}

bool app_key_pressed(void)
{
    return s_pressed;
}
