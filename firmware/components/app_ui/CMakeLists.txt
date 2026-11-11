idf_component_register(
    SRCS "app_ui.c"
    INCLUDE_DIRS "."
    REQUIRES bsp_board app_mouse app_voice rtc_board lvgl__lvgl espressif__esp_lvgl_adapter
)
