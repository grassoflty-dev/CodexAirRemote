idf_component_register(
    SRCS "lvgl_bsp.cpp"
    INCLUDE_DIRS "."
    REQUIRES
        bsp_port
        lvgl__lvgl
    PRIV_REQUIRES
        esp_timer
        espressif__esp_lvgl_adapter
)
