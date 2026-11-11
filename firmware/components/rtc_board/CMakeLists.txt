idf_component_register(
    SRCS "rtc_board.c"
    INCLUDE_DIRS "include"
    REQUIRES bsp_board esp_driver_i2c
)
