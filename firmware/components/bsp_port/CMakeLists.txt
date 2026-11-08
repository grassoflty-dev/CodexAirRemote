idf_component_register(
    SRCS
        "i2c_bsp.cpp"
        "display_bsp.cpp"
        "codec_bsp.cpp"
        "power_bsp.cpp"
        "xpowers/XPowersLibInterface.cpp"
    INCLUDE_DIRS
        "."
        "xpowers"
        "xpowers/REG"
    # Public headers (user_config.h, display_bsp.h, codec_bsp.h, power_bsp.h)
    # expose types from these components, so they must be public requirements.
    REQUIRES
        driver
        esp_driver_gpio
        esp_driver_i2c
        esp_driver_spi
        esp_lcd
        codec_board
        waveshare__esp_lcd_touch_cst9217
    PRIV_REQUIRES
        esp_driver_i2s
        esp_timer
        espressif__esp_lcd_sh8601
        esp_codec_dev
)
target_compile_definitions(${COMPONENT_LIB} PRIVATE
    XPOWERS_CHIP_AXP2101
    CONFIG_XPOWERS_ESP_IDF_NEW_API
)
