#include <stdio.h>
#include <string.h>
#include <freertos/FreeRTOS.h>
#include <esp_log.h>
#include <esp_timer.h>
#include "lvgl_bsp.h"
#include <esp_lcd_touch.h>
#include "esp_lv_adapter.h"
#include "user_config.h"

//static const char *TAG = "LvglPort";

static lv_display_t *disp = NULL;

esp_err_t Lvgl_lock(int timeout_ms)
{
  	return esp_lv_adapter_lock(timeout_ms);      
}

void Lvgl_unlock(void)
{
  	esp_lv_adapter_unlock();
}

#if LVGL_VERSION_MAJOR >= 9
static void rounder_event_cb(lv_event_t *e)
{
    lv_area_t *area = (lv_area_t *)lv_event_get_param(e);
    uint16_t x1 = area->x1;
    uint16_t x2 = area->x2;

    uint16_t y1 = area->y1;
    uint16_t y2 = area->y2;

    // round the start of coordinate down to the nearest 2M number
    area->x1 = (x1 >> 1) << 1;
    area->y1 = (y1 >> 1) << 1;
    // round the end of coordinate up to the nearest 2N+1 number
    area->x2 = ((x2 >> 1) << 1) + 1;
    area->y2 = ((y2 >> 1) << 1) + 1;
}
#else
static void bsp_lvgl_rounder_cb(lv_disp_drv_t *disp_drv, lv_area_t *area)
{
    uint16_t x1 = area->x1;
    uint16_t x2 = area->x2;

    uint16_t y1 = area->y1;
    uint16_t y2 = area->y2;

    // round the start of coordinate down to the nearest 2M number
    area->x1 = (x1 >> 1) << 1;
    area->y1 = (y1 >> 1) << 1;
    // round the end of coordinate up to the nearest 2N+1 number
    area->x2 = ((x2 >> 1) << 1) + 1;
    area->y2 = ((y2 >> 1) << 1) + 1;
}
#endif

void Lvgl_PortInit(DisplayPort &display) {
    esp_lv_adapter_config_t cfg = ESP_LV_ADAPTER_DEFAULT_CONFIG();
    /* ESP32-C6 has a single core and no PSRAM: keep the LVGL task lean. */
    cfg.task_stack_size = 20 * 1024;
    cfg.task_priority = 8;
    cfg.task_core_id = 0;
    cfg.stack_in_psram = false;

    ESP_ERROR_CHECK(esp_lv_adapter_init(&cfg));
    esp_lcd_panel_handle_t panel_handle = display.Get_PanelHandle();
    esp_lcd_panel_io_handle_t io_handle = display.Get_IoHandle();
    esp_lv_adapter_display_config_t disp_cfg = ESP_LV_ADAPTER_DISPLAY_SPI_WITHOUT_PSRAM_DEFAULT_CONFIG(
        panel_handle,
        io_handle,
        BSP_LCD_H_RES,
        BSP_LCD_V_RES,
        ESP_LV_ADAPTER_ROTATE_0
    );
    /* 480 x 8 x 2 bytes = 7.5 KiB draw buffer, single buffered. */
    disp_cfg.profile.buffer_height = 12;
	
	disp = esp_lv_adapter_register_display(&disp_cfg);
    assert(disp != NULL);
#if LVGL_VERSION_MAJOR >= 9
    lv_display_add_event_cb(disp, rounder_event_cb, LV_EVENT_INVALIDATE_AREA, NULL);
#else
    lv_disp_t *disp_v8 = (lv_disp_t *)disp;
    if (disp_v8 && disp_v8->driver) {
        disp_v8->driver->rounder_cb = bsp_lvgl_rounder_cb;
    }
#endif

    if(display.Get_TouchInitialized()) {
        esp_lcd_touch_handle_t touch_handle = display.Get_TouchHandle();
        esp_lv_adapter_touch_config_t touch_cfg = ESP_LV_ADAPTER_TOUCH_DEFAULT_CONFIG(disp, touch_handle);
        lv_indev_t *touch = esp_lv_adapter_register_touch(&touch_cfg);
        assert(touch != NULL);
    }

	ESP_ERROR_CHECK(esp_lv_adapter_start());
}

void Lvgl_Refresh(void) {
    esp_lv_adapter_refresh_now(disp);
}