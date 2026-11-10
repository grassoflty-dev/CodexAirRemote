/*
 * Legacy pin macro names kept for the ported BSP sources. The actual values live
 * in board_pins.h so a variant switch only needs one edit / Kconfig option.
 */
#pragma once

#include "board_pins.h"

#define BSP_I2C_NUM             (BOARD_I2C_NUM)
#define BSP_I2C_SCL             (BOARD_I2C_SCL)
#define BSP_I2C_SDA             (BOARD_I2C_SDA)
#define BSP_PMU_I2C_ADDR        (BOARD_PMU_I2C_ADDR)

#define BSP_I2S_SCLK            (BOARD_I2S_SCLK)
#define BSP_I2S_MCLK            (BOARD_I2S_MCLK)
#define BSP_I2S_LCLK            (BOARD_I2S_LCLK)
#define BSP_I2S_DOUT            (BOARD_I2S_DOUT)
#define BSP_I2S_DSIN            (BOARD_I2S_DSIN)

#define BSP_LCD_H_RES           (BOARD_LCD_H_RES)
#define BSP_LCD_V_RES           (BOARD_LCD_V_RES)
#define BSP_LCD_SPI_NUM         (BOARD_LCD_SPI_NUM)
#define BSP_LCD_PCLK            (BOARD_LCD_PCLK)
#define BSP_LCD_DATA0           (BOARD_LCD_DATA0)
#define BSP_LCD_DATA1           (BOARD_LCD_DATA1)
#define BSP_LCD_DATA2           (BOARD_LCD_DATA2)
#define BSP_LCD_DATA3           (BOARD_LCD_DATA3)
#define BSP_LCD_BITS_PER_PIXEL  (BOARD_LCD_BITS_PER_PIXEL)
#define BSP_LCD_BACKLIGHT       (BOARD_LCD_BACKLIGHT)
#define BSP_LCD_RST             (BOARD_LCD_RST)

#define BSP_LCD_CS              (BOARD_LCD_CS)
#define BSP_LCD_TOUCH_INT       (BOARD_LCD_TOUCH_INT)
#define BSP_LCD_TOUCH_RST       (BOARD_LCD_TOUCH_RST)
