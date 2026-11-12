#pragma once

#include <stdbool.h>

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

/*
 * 侧边第三个实体按键（官方资料称 KEY 键，接 GPIO10，10K 上拉到 3V3，按下拉低，
 * 无硬件消抖电容）。BOOT 键接 GPIO9、电源键接 AXP2101 PWRKEY，都不由本组件处理。
 *
 * 每个按下周期只回调一次：按下确认后按住超过 1 s 立即回调一次（长按），
 * 1 s 内松开则回松开时回调一次（短按）；按住期间不重复回调，松开也不会再回调。
 */
typedef void (*app_key_press_cb_t)(void);

/* 配置按键引脚、启动 5 ms 轮询任务。重复调用返回 ESP_OK。 */
esp_err_t app_key_init(void);

/* 注册按下回调，回调在按键任务上下文里执行，不得直接调用 LVGL。 */
void app_key_set_press_cb(app_key_press_cb_t callback);

/* 按键当前是否处于按下状态（已消抖），供日志与诊断使用。 */
bool app_key_pressed(void);

#ifdef __cplusplus
}
#endif
