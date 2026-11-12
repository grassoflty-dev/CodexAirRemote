/*
 * Board pin map for the Waveshare ESP32-C6-Touch-AMOLED-2.16.
 *
 * Single source of truth for every pin. Two independent sources disagree on
 * LCD CS vs touch INT, so the choice is a compile-time variant:
 *
 *   variant A (default): LCD_CS = GPIO15, TOUCH_INT = GPIO5
 *     - mfellner/esp32-playground components/board/board.cpp runs exactly this
 *       on the same board (docs/hardware.md: "QSPI clock 0, data 1/2/3/4,
 *       CS 15, touch INT 5, reset 11; vendor user_config.h reverses CS/INT but
 *       those macros are unused in the demo constructor").
 *     - waveshareteam/ESP32-C6-Touch-AMOLED-2.16 09_LVGL_V9_Test/display_bsp.h
 *       constructor defaults are also cs=15, tp_int=5.
 *   variant B: LCD_CS = GPIO5, TOUCH_INT = GPIO15
 *     - waveshare/esp32_c6_touch_amoled_2_06 (official C6 BSP, same MCU family)
 *       header uses BSP_LCD_CS GPIO5 / BSP_LCD_TOUCH_INT GPIO15.
 *
 * Default: A (two independent sources agree). To validate variant B without
 * touching any other file, add this to sdkconfig.defaults / menuconfig:
 *     CONFIG_BOARD_LCD_PINS_VARIANT_B=y
 */
#pragma once

#include "driver/gpio.h"
#include "sdkconfig.h"

#define BOARD_LCD_PINS_VARIANT_A 1
#define BOARD_LCD_PINS_VARIANT_B 2

#ifdef CONFIG_BOARD_LCD_PINS_VARIANT_B
#define BOARD_LCD_PINS_VARIANT BOARD_LCD_PINS_VARIANT_B
#else
#define BOARD_LCD_PINS_VARIANT BOARD_LCD_PINS_VARIANT_A
#endif

/* Shared (both variants). */
#define BOARD_I2C_NUM       (I2C_NUM_0)
#define BOARD_I2C_SCL       (GPIO_NUM_7)
#define BOARD_I2C_SDA       (GPIO_NUM_8)
#define BOARD_PMU_I2C_ADDR  (0x34)

#define BOARD_I2S_SCLK      (GPIO_NUM_20)
#define BOARD_I2S_MCLK      (GPIO_NUM_19)
#define BOARD_I2S_LCLK      (GPIO_NUM_22)
#define BOARD_I2S_DOUT      (GPIO_NUM_23)
#define BOARD_I2S_DSIN      (GPIO_NUM_21)

/* 侧面第三个实体按键（官方资料称 KEY 键）：GPIO10，10K 上拉到 3V3，按下拉低，
 * 无硬件消抖电容。BOOT 键是 GPIO9，电源键接 AXP2101 PWRKEY（不占 GPIO）。 */
#define BOARD_KEY_BUTTON    (GPIO_NUM_10)

#define BOARD_LCD_H_RES         (480)
#define BOARD_LCD_V_RES         (480)
#define BOARD_LCD_SPI_NUM       (SPI2_HOST)
#define BOARD_LCD_PCLK          (GPIO_NUM_0)
#define BOARD_LCD_DATA0         (GPIO_NUM_1)
#define BOARD_LCD_DATA1         (GPIO_NUM_2)
#define BOARD_LCD_DATA2         (GPIO_NUM_3)
#define BOARD_LCD_DATA3         (GPIO_NUM_4)
#define BOARD_LCD_BITS_PER_PIXEL (16)
#define BOARD_LCD_BACKLIGHT     (GPIO_NUM_NC)
#define BOARD_LCD_RST           (GPIO_NUM_NC)
#define BOARD_LCD_TOUCH_RST     (GPIO_NUM_11)

#if BOARD_LCD_PINS_VARIANT == BOARD_LCD_PINS_VARIANT_B
#define BOARD_LCD_CS        (GPIO_NUM_5)
#define BOARD_LCD_TOUCH_INT (GPIO_NUM_15)
#else
#define BOARD_LCD_CS        (GPIO_NUM_15)
#define BOARD_LCD_TOUCH_INT (GPIO_NUM_5)
#endif
