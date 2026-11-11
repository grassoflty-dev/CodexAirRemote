idf_component_register(SRCS "air_mouse.c" "ble_mouse.c" INCLUDE_DIRS "." PRIV_REQUIRES nvs_flash
    REQUIRES bsp_board app_busy esp_driver_i2c esp_timer bt esp_hid waveshare__qmi8658)
