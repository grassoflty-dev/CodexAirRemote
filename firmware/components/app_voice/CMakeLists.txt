idf_component_register(SRCS "voice.c"
    INCLUDE_DIRS "."
    REQUIRES bsp_board app_busy app_mouse app_provision app_identity esp_driver_gpio esp_driver_i2c esp_driver_i2s
             esp_event esp_https_server esp_http_server esp_netif esp_timer esp_wifi mbedtls
             nvs_flash spi_flash)
