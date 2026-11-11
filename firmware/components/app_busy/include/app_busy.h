#pragma once

#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

/*
 * "The board is busy doing something" holds, kept in one place so that the
 * standby timer only runs when no feature owns the board. A hold is not a
 * UI interaction that just restarts a countdown: while any hold is active the
 * countdown is pinned at zero, so it starts over from the moment the last
 * hold is released.
 *
 * Every long-lived feature registers here instead of adding its own exception
 * to the standby logic. The implementation is a bitmask, so acquire/release
 * are idempotent per holder: a duplicated release cannot cancel somebody
 * else's hold, and a missed release is visible in the log as a stuck mask.
 */
typedef enum {
    APP_BUSY_VOICE = 1u << 0,   /* voice session: start of the attempt until the
                                 * terminal state (recording, upload, result) */
    APP_BUSY_GYRO = 1u << 1,    /* gyro/mouse runtime, calibration included */
    APP_BUSY_CONSOLE = 1u << 2, /* blocking console command (time set, ...) */
} app_busy_t;

void app_busy_acquire(app_busy_t who);

void app_busy_release(app_busy_t who);

/* True while at least one holder is active. */
bool app_busy_active(void);

/* Number of distinct active holders (0 when idle). */
unsigned app_busy_count(void);

/* Current holder mask, for logging. */
unsigned app_busy_mask(void);

#ifdef __cplusplus
}
#endif
