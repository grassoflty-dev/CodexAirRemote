#include <stdio.h>
#include <string.h>
#include <freertos/FreeRTOS.h>
#include <esp_log.h>
#include "display_bsp.h"
#include "esp_lcd_sh8601.h"
#include "power_bsp.h"

static const sh8601_lcd_init_cmd_t lcd_init_cmds[] = {
    {0x11, (uint8_t[]){0x00}, 0, 600}, 
    {0xFE, (uint8_t[]){0x20}, 1, 0},
    {0x19, (uint8_t[]){0x10}, 1, 0},
    {0x1C, (uint8_t[]){0xA0}, 1, 0},
    {0xFE, (uint8_t[]){0x00}, 1, 0},
    {0xC4, (uint8_t[]){0x80}, 1, 0},
    {0x3A, (uint8_t[]){0x55}, 1, 0},
    {0x35, (uint8_t[]){0x00}, 1, 0},
    {0x36, (uint8_t[]){0x30}, 1, 0},
    {0x53, (uint8_t[]){0x20}, 1, 0},
    {0x51, (uint8_t[]){0xFF}, 1, 0},
    {0x63, (uint8_t[]){0xFF}, 1, 0},
    {0x2A, (uint8_t[]){0x00, 0x00, 0x01, 0xDF}, 4, 0},
    {0x2B, (uint8_t[]){0x00, 0x00, 0x01, 0xDF}, 4, 0},
    {0x29, (uint8_t[]){0x00}, 0, 100}, 
};

DisplayPort::DisplayPort(I2cMasterBus &i2cbus,int width,int height,int scl, int d0, int d1, int d2, int d3, int cs, int tp_int, int tp_reset, spi_host_device_t spihost) : 
i2cbus_(i2cbus),
spihost_(spihost),
width_(width),
height_(height),
tp_int_(tp_int),
tp_reset_(tp_reset)
{
	int max_transfer_sz = width_ * 50 * 2;
	ESP_LOGI(TAG, "SPI BUS init");
	spi_bus_config_t buscfg = {};
    buscfg.sclk_io_num  = scl,              
    buscfg.data0_io_num = d0,                   
    buscfg.data1_io_num = d1,                   
    buscfg.data2_io_num = d2,                   
    buscfg.data3_io_num = d3,                      
    buscfg.max_transfer_sz = max_transfer_sz;
    ESP_ERROR_CHECK(spi_bus_initialize(spihost, &buscfg, SPI_DMA_CH_AUTO));

	ESP_LOGI(TAG, "Install panel IO");

    esp_lcd_panel_io_spi_config_t io_config = {};
    io_config.cs_gpio_num = cs;       
    io_config.dc_gpio_num = -1;           
    io_config.spi_mode = 0;               
    io_config.pclk_hz = 40 * 1000 * 1000; 
    io_config.trans_queue_depth = 1;     
    io_config.on_color_trans_done = NULL;   
    io_config.user_ctx = NULL;          
    io_config.lcd_cmd_bits = 32;          
    io_config.lcd_param_bits = 8;         
    io_config.flags.quad_mode = true;                       
	ESP_ERROR_CHECK(esp_lcd_new_panel_io_spi((esp_lcd_spi_bus_handle_t)spihost, &io_config, &io_handle));

    sh8601_vendor_config_t vendor_config = {};
    vendor_config.init_cmds = lcd_init_cmds;
    vendor_config.init_cmds_size = sizeof(lcd_init_cmds) / sizeof(lcd_init_cmds[0]);
    vendor_config.flags.use_qspi_interface = 1;

	esp_lcd_panel_dev_config_t panel_config = {};
    panel_config.reset_gpio_num = GPIO_NUM_NC;
    panel_config.rgb_ele_order = LCD_RGB_ELEMENT_ORDER_RGB;
    panel_config.bits_per_pixel = 16;
    panel_config.vendor_config = &vendor_config;
	
	ESP_ERROR_CHECK(esp_lcd_new_panel_sh8601(io_handle, &panel_config, &panel_handle));
	ESP_ERROR_CHECK(DisplayPort_DispReset());
    ESP_ERROR_CHECK(esp_lcd_panel_init(panel_handle));
}

DisplayPort::~DisplayPort() {
}

int DisplayPort::DisplayPort_DispReset(void) {
	Axp2101_SetAldo3(1);
	vTaskDelay(pdMS_TO_TICKS(100));
	Axp2101_SetAldo3(0);
	vTaskDelay(pdMS_TO_TICKS(100));
	Axp2101_SetAldo3(1);
	vTaskDelay(pdMS_TO_TICKS(100));
	return ESP_OK;
} 

void DisplayPort::DisplayPort_TouchInit(void) {
    const esp_lcd_touch_config_t tp_cfg = {
        .x_max = (uint16_t)width_,
        .y_max = (uint16_t)height_,
        .rst_gpio_num = (gpio_num_t)tp_reset_, 
        .int_gpio_num = (gpio_num_t)tp_int_,
        .levels = {
            .reset = 0,
            .interrupt = 0,
        },
        .flags = {
            .swap_xy = 1,
            .mirror_x = 0,
            .mirror_y = 1,
        },
    };
    esp_lcd_panel_io_handle_t tp_io_handle = NULL;
    esp_lcd_panel_io_i2c_config_t tp_io_config = ESP_LCD_TOUCH_IO_I2C_CST9217_CONFIG();
    tp_io_config.scl_speed_hz = 400000;
    ESP_ERROR_CHECK(esp_lcd_new_panel_io_i2c(i2cbus_.Get_I2cBusHandle(), &tp_io_config, &tp_io_handle));
    ESP_ERROR_CHECK(esp_lcd_touch_new_i2c_cst9217(tp_io_handle, &tp_cfg, &ret_touch));
    is_touchinitialized_ = true;
}

void DisplayPort::Set_Backlight(uint8_t brightness) {
    if(brightness > 100) brightness = 100;
    brightness_ = brightness;
    uint8_t bl_val = (uint8_t)((brightness_ * 255) / 100);
    uint32_t CMD = 0x51;
    CMD &= 0xFF;
    CMD <<= 8;
    CMD |= 0x02 << 24;
    esp_lcd_panel_io_tx_param(io_handle, CMD, &bl_val,1);
}

/*
 * QSPI 写命令字：高字节是 opcode（0x02 = 写命令/参数），低字节是面板命令。
 * esp_lcd_sh8601 内部用同样的拼法，但那个宏没有导出到公开头文件。
 */
static uint32_t Sh8601_WriteCmd(uint8_t cmd) {
    uint32_t word = 0x02;

    word <<= 24;
    word |= (uint32_t)cmd << 8;

    return word;
}

/*
 * 硬件旋转：只改 MADCTL 的 MY/MX/MV 三个旋转位，其余位（ML、BGR 等）保持
 * lcd_init_cmds 里 0x36 的基线值，颜色顺序和刷新方向都不动。
 *
 * 基线 0x30 = MV|ML，是 0 度（当前固件正常显示的方向）。以它为基准的四个
 * 组合（掩码是对基线做异或）：
 *   0  度: 0x30            （不变）
 *   90 度: 0x30 ^ 0x60 = 0x50   （关 MV，开 MX）
 *   180度: 0x30 ^ 0xC0 = 0xF0   （开 MX+MY）
 *   270度: 0x30 ^ 0xA0 = 0x90   （关 MV，开 MY）
 * 推导：MV 置位时 CASET/RASET 与面板的行列互换，此时 MX 翻转的是图像的纵向、
 * MY 翻转横向；MV 清零后 MX 直接翻横向、MY 翻纵向。要把逻辑像素 (x,y) 放到
 * 物理位置 (y, 479-x)（即 LVGL 的 LV_DISPLAY_ROTATION_90 约定，逆时针 90 度），
 * 需要"横向翻转 + 取消行列互换"，就是 0x50；180 度是"横纵都翻"= 0xF0；270 度
 * 是"纵向翻转 + 取消行列互换"= 0x90。方形屏 480x480，行列互换不影响分辨率。
 *
 * 必须在 esp_lcd_panel_init() 之后写：init 序列末尾的 {0x36, 0x30} 会覆盖驱动
 * 自己发的那次 MADCTL（日志里 "The 36h command has been used and will be
 * overwritten by external initialization sequence" 说的就是它）。
 */
esp_err_t DisplayPort::Set_Rotate(uint16_t degrees) {
    static const uint8_t rotate_mask[4] = {0x00, 0x60, 0xC0, 0xA0};
    uint8_t step = (uint8_t)((degrees / 90) % 4);
    uint8_t madctl = (uint8_t)(0x30 ^ rotate_mask[step]);
    esp_err_t err;

    err = esp_lcd_panel_io_tx_param(io_handle, Sh8601_WriteCmd(0x36), &madctl, 1);
    if(err != ESP_OK) {
        ESP_LOGE(TAG, "MADCTL 0x36 <- 0x%02x failed: %s", madctl, esp_err_to_name(err));
        return err;
    }

    madctl_ = madctl;
    ESP_LOGI(TAG, "MADCTL 0x36 <- 0x%02x (%u deg, base 0x30 ^ mask 0x%02x)",
             madctl, (unsigned)(step * 90), rotate_mask[step]);

    return ESP_OK;
}
