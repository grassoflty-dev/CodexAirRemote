idf_component_register(
    SRCS "board.cpp"
    INCLUDE_DIRS "include"
    REQUIRES
        bsp_port
        bsp_app
        lvgl__lvgl
        esp_codec_dev
        esp_driver_i2c
)
