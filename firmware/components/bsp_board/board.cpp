#include "board.h"

#include <esp_log.h>
#include <esp_timer.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>

#include "codec_bsp.h"
#include "display_bsp.h"
#include "esp_heap_caps.h"
#include "i2c_bsp.h"
#include "lvgl_bsp.h"
#include "power_bsp.h"
#include "user_config.h"

static I2cMasterBus *s_bus = NULL;
static DisplayPort *s_display = NULL;
static CodecPort *s_codec = NULL;

/* Split initialisation lets app_main give BLE the first, least fragmented
 * allocations before the LVGL draw buffer and the rest of the UI memory. */
extern "C" esp_err_t board_bus_init(void)
{
    if (s_bus) {
        return ESP_OK;
    }
    s_bus = new I2cMasterBus(BSP_I2C_SCL, BSP_I2C_SDA, BSP_I2C_NUM);
    if (!s_bus) {
        return ESP_ERR_NO_MEM;
    }
    /* AXP2101 first: it powers the panel rail (ALDO3) that the display driver
     * toggles during reset, and it reports battery state for the UI. */
    Custom_PmicPortInit(s_bus, BSP_PMU_I2C_ADDR);
    return ESP_OK;
}

extern "C" esp_err_t board_display_start(void)
{
    if (s_display) {
        return ESP_OK;
    }
    if (board_bus_init() != ESP_OK) {
        return ESP_ERR_NO_MEM;
    }
    s_display = new DisplayPort(*s_bus, BSP_LCD_H_RES, BSP_LCD_V_RES,
                                BSP_LCD_PCLK, BSP_LCD_DATA0, BSP_LCD_DATA1,
                                BSP_LCD_DATA2, BSP_LCD_DATA3, BSP_LCD_CS,
                                BSP_LCD_TOUCH_INT, BSP_LCD_TOUCH_RST, BSP_LCD_SPI_NUM);
    if (!s_display) {
        return ESP_ERR_NO_MEM;
    }
    s_display->DisplayPort_TouchInit();
    Lvgl_PortInit(*s_display);
    return ESP_OK;
}

/* TEMP display bisect (remove before delivery): panel only, no touch/LVGL. */
extern "C" esp_err_t board_display_probe_start(void)
{
    if (s_display) {
        return ESP_OK;
    }
    if (board_bus_init() != ESP_OK) {
        return ESP_ERR_NO_MEM;
    }
    s_display = new DisplayPort(*s_bus, BSP_LCD_H_RES, BSP_LCD_V_RES,
                                BSP_LCD_PCLK, BSP_LCD_DATA0, BSP_LCD_DATA1,
                                BSP_LCD_DATA2, BSP_LCD_DATA3, BSP_LCD_CS,
                                BSP_LCD_TOUCH_INT, BSP_LCD_TOUCH_RST, BSP_LCD_SPI_NUM);
    return s_display ? ESP_OK : ESP_ERR_NO_MEM;
}

extern "C" esp_err_t board_audio_init(void)
{
    if (s_codec) {
        return ESP_OK;
    }
    if (board_bus_init() != ESP_OK) {
        return ESP_ERR_NO_MEM;
    }
    s_codec = new CodecPort(*s_bus, "C6_AMOLED_2_16");
    return s_codec ? ESP_OK : ESP_ERR_NO_MEM;
}

extern "C" esp_err_t board_init(void)
{
    esp_err_t err = board_bus_init();
    if (err != ESP_OK) {
        return err;
    }
    err = board_display_start();
    if (err != ESP_OK) {
        return err;
    }
    return board_audio_init();
}

extern "C" lv_display_t *board_display(void)
{
    return lv_display_get_default();
}

extern "C" bool board_lock(int timeout_ms)
{
    return Lvgl_lock(timeout_ms) == ESP_OK;
}

extern "C" void board_unlock(void)
{
    Lvgl_unlock();
}

extern "C" i2c_master_bus_handle_t board_i2c_bus(void)
{
    return s_bus ? s_bus->Get_I2cBusHandle() : NULL;
}

extern "C" esp_err_t board_set_brightness(int percent)
{
    if (!s_display) {
        return ESP_ERR_INVALID_STATE;
    }
    if (percent < 0) {
        percent = 0;
    }
    if (percent > 100) {
        percent = 100;
    }
    s_display->Set_Backlight((uint8_t)percent);
    return ESP_OK;
}

extern "C" bool board_battery_connected(void)
{
    return Axp2101_IsBatteryConnected();
}

extern "C" int board_battery_percent(void)
{
    return Axp2101_GetBatteryPercent();
}

extern "C" esp_codec_dev_handle_t board_microphone(void)
{
    return s_codec ? s_codec->microphone() : NULL;
}


/* TEMP panel bisect (remove when the panel issue is closed): push a solid
 * colour straight to the panel with esp_lcd_panel_draw_bitmap so the SPI path
 * can be tested without LVGL involved at all. */
extern "C" esp_err_t board_panel_fill(uint16_t color)
{
    if (!s_display) {
        return ESP_ERR_INVALID_STATE;
    }
    static uint16_t strip[480 * 20];
    for (int i = 0; i < 480 * 20; i++) {
        strip[i] = color;
    }
    esp_lcd_panel_handle_t panel = s_display->Get_PanelHandle();
    for (int y = 0; y < 480; y += 20) {
        int64_t t0 = esp_timer_get_time();
        esp_err_t err = esp_lcd_panel_draw_bitmap(panel, 0, y, 480, y + 20, strip);
        int64_t dt = esp_timer_get_time() - t0;
        ESP_LOGI("panel_direct", "draw rows %d-%d -> %s (%lld us)", y, y + 20,
                 esp_err_to_name(err), (long long)dt);
        if (err != ESP_OK) {
            return err;
        }
    }
    ESP_LOGI("panel_direct", "ALDO3 enabled=%d after write",
             Axp2101_IsAldo3Enabled() ? 1 : 0);
    vTaskDelay(pdMS_TO_TICKS(500));
    ESP_LOGI("panel_direct", "panel write done, heap %u",
             (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL));
    return ESP_OK;
}