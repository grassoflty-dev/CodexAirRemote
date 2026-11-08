#include "board.h"

#include "codec_bsp.h"
#include "display_bsp.h"
#include "i2c_bsp.h"
#include "lvgl_bsp.h"
#include "power_bsp.h"
#include "user_config.h"

static I2cMasterBus *s_bus = NULL;
static DisplayPort *s_display = NULL;
static CodecPort *s_codec = NULL;

extern "C" esp_err_t board_init(void)
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

    s_display = new DisplayPort(*s_bus, BSP_LCD_H_RES, BSP_LCD_V_RES,
                                BSP_LCD_PCLK, BSP_LCD_DATA0, BSP_LCD_DATA1,
                                BSP_LCD_DATA2, BSP_LCD_DATA3, BSP_LCD_CS,
                                BSP_LCD_TOUCH_INT, BSP_LCD_TOUCH_RST, BSP_LCD_SPI_NUM);
    if (!s_display) {
        return ESP_ERR_NO_MEM;
    }
    s_display->DisplayPort_TouchInit();
    Lvgl_PortInit(*s_display);

    s_codec = new CodecPort(*s_bus, "C6_AMOLED_2_16");
    return ESP_OK;
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
