idf_component_register(
    SRCS "app_main.c"
    INCLUDE_DIRS "."
    REQUIRES bsp_board app_ui app_mouse app_voice app_provision rtc_board
    PRIV_REQUIRES
        esp_driver_gpio
        esp_driver_i2c
        esp_driver_i2s
        esp_driver_usb_serial_jtag
        esp_timer
        esp_event
        esp_hid
        bt
        nvs_flash
        esp_wifi
        esp_netif
        esp_https_server
        esp_http_server
        mbedtls
        spi_flash
        esp_hw_support
        esp_codec_dev
)

