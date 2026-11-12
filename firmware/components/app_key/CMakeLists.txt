idf_component_register(
    SRCS "app_key.c"
    INCLUDE_DIRS "include"
    REQUIRES bsp_board esp_driver_gpio esp_timer
)
