/* Bitmask of long-lived feature holds; see app_busy.h for the contract. */
#include "app_busy.h"

#include <stdatomic.h>

#include "esp_log.h"

static const char *TAG = "busy";
static atomic_uint s_mask;

static const char *holder_name(unsigned who)
{
    switch (who) {
    case APP_BUSY_VOICE: return "voice";
    case APP_BUSY_GYRO: return "gyro";
    case APP_BUSY_CONSOLE: return "console";
    default: return "?";
    }
}

void app_busy_acquire(app_busy_t who)
{
    unsigned before = atomic_fetch_or(&s_mask, (unsigned)who);
    if (!(before & (unsigned)who)) {
        ESP_LOGI(TAG, "hold +%s, mask 0x%x", holder_name((unsigned)who), before | (unsigned)who);
    }
}

void app_busy_release(app_busy_t who)
{
    unsigned before = atomic_fetch_and(&s_mask, ~(unsigned)who);
    if (!(before & (unsigned)who)) {
        /* Releasing something that was not held means the feature state and the
         * hold went out of sync; make it loud instead of hiding it. */
        ESP_LOGW(TAG, "hold -%s without a matching hold, mask 0x%x",
                 holder_name((unsigned)who), before);
        return;
    }
    ESP_LOGI(TAG, "hold -%s, mask 0x%x", holder_name((unsigned)who),
             before & ~(unsigned)who);
}

bool app_busy_active(void)
{
    return atomic_load(&s_mask) != 0;
}

unsigned app_busy_count(void)
{
    unsigned mask = atomic_load(&s_mask);
    unsigned count = 0;
    while (mask) {
        count += mask & 1u;
        mask >>= 1;
    }
    return count;
}

unsigned app_busy_mask(void)
{
    return atomic_load(&s_mask);
}
