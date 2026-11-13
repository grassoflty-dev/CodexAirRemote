#pragma once

#include <driver/gpio.h>
#include <driver/spi_master.h>
#include <esp_lcd_panel_io.h>
#include <esp_lcd_panel_vendor.h>
#include <esp_lcd_panel_ops.h>

#include "i2c_bsp.h"
#include "esp_lcd_touch_cst9217.h"

class DisplayPort {
private:
    const char * TAG = "DisplayPort";
    esp_lcd_panel_handle_t panel_handle = NULL;
    esp_lcd_panel_io_handle_t io_handle = NULL;
    esp_lcd_touch_handle_t ret_touch = NULL;
    I2cMasterBus &i2cbus_;
    spi_host_device_t spihost_;
    int width_;
    int height_;
    int tp_int_;
    int tp_reset_;
    bool is_touchinitialized_ = false;
    uint8_t brightness_ = 100;
    uint8_t madctl_ = 0x30;

    int DisplayPort_DispReset(void);
public:
    DisplayPort(I2cMasterBus &i2cbus,int width,int height,int scl = 0, int d0 = 1, int d1 = 2, int d2 = 3, int d3 = 4, int cs = 15, int tp_int = 5, int tp_reset = 11, spi_host_device_t spihost = SPI2_HOST);
    ~DisplayPort();

    void DisplayPort_TouchInit(void);
    void Set_Backlight(uint8_t brightness);

    /* 用 SH8601 的 MADCTL(0x36) 做硬件旋转，degrees 取 0/90/180/270（其它值按
     * 90 度向下取整）。像素由面板自己搬，刷屏回调不需要转置，也就不再需要 DMA
     * scratch。返回 ESP_OK 只表示 SPI 命令已发出：SH8601 的 QSPI 读通路没有
     * 实现，MADCTL 读回不可靠，所以这里不读回校验。 */
    esp_err_t Set_Rotate(uint16_t degrees);

    /* 最近一次成功写入的 MADCTL 值，用于日志和排查。 */
    uint8_t Get_Madctl(void) { return madctl_; }

    spi_host_device_t Get_SpiHost() { return spihost_; }
    esp_lcd_panel_handle_t Get_PanelHandle() { return panel_handle; }
    esp_lcd_panel_io_handle_t Get_IoHandle() { return io_handle; }
    int Get_Width() { return width_; }
    int Get_Height() { return height_; }
    esp_lcd_touch_handle_t Get_TouchHandle() { return ret_touch; }
    bool Get_TouchInitialized() { return is_touchinitialized_; }
    uint8_t Get_Brightness() { return brightness_; }
};