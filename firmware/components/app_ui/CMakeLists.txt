idf_component_register(
    SRCS "app_ui.c" "fonts/ui_font_standby_160.c"
    INCLUDE_DIRS "."
    REQUIRES bsp_board app_mouse app_voice app_busy rtc_board lvgl__lvgl espressif__esp_lvgl_adapter
)
