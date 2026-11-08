/*
 * ESP32-C6-Touch-AMOLED-2.16 board pin map.
 *
 * Verified against the Waveshare product repository
 * (github.com/waveshareteam/ESP32-C6-Touch-AMOLED-2.16, 02_Example/ESP-IDF-v5.5.3)
 * and the board pin table published for the 2.16 hardware:
 *   LCD (SH8601, QSPI): CLK GPIO0, D0..D3 GPIO1..4, CS GPIO15, no reset pin
 *                       (the panel rail is power-cycled through AXP2101 ALDO3)
 *   Touch (CST9217, I2C): SCL GPIO7, SDA GPIO8, RST GPIO11, INT GPIO5, addr 0x5A
 *   PMU (AXP2101, I2C): addr 0x34
 *   Audio (ES8311 speaker / ES7210 mic, I2S TDM): MCLK 19, BCLK 20, WS 22,
 *                       DIN (mic) 21, DOUT (speaker) 23
 *
 * Note: the upstream example ships a user_config.h whose LCD CS / touch INT
 * values are swapped (5/15). Its own working code passes the constructor
 * defaults (CS 15, touch INT 5), which is what is used here.
 */
#ifndef USER_CONFIG_H
#define USER_CONFIG_H

#include "driver/gpio.h"
#include "driver/i2c_master.h"
#include "driver/spi_master.h"

#define BSP_I2C_NUM             (I2C_NUM_0)
#define BSP_I2C_SCL             (GPIO_NUM_7)
#define BSP_I2C_SDA             (GPIO_NUM_8)

#define BSP_PMU_I2C_ADDR        (0x34)

#define BSP_I2S_SCLK            (GPIO_NUM_20)
#define BSP_I2S_MCLK            (GPIO_NUM_19)
#define BSP_I2S_LCLK            (GPIO_NUM_22)
#define BSP_I2S_DOUT            (GPIO_NUM_23)
#define BSP_I2S_DSIN            (GPIO_NUM_21)

#define BSP_LCD_H_RES           (480)
#define BSP_LCD_V_RES           (480)
#define BSP_LCD_SPI_NUM         (SPI2_HOST)
#define BSP_LCD_CS              (GPIO_NUM_15)
#define BSP_LCD_PCLK            (GPIO_NUM_0)
#define BSP_LCD_DATA0           (GPIO_NUM_1)
#define BSP_LCD_DATA1           (GPIO_NUM_2)
#define BSP_LCD_DATA2           (GPIO_NUM_3)
#define BSP_LCD_DATA3           (GPIO_NUM_4)
#define BSP_LCD_BITS_PER_PIXEL  (16)
#define BSP_LCD_BACKLIGHT       (GPIO_NUM_NC)
#define BSP_LCD_RST             (GPIO_NUM_NC)

#define BSP_LCD_TOUCH_INT       (GPIO_NUM_5)
#define BSP_LCD_TOUCH_RST       (GPIO_NUM_11)

#endif /* USER_CONFIG_H */
