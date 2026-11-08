idf_component_register(
    SRCS "app_main.c" "air_mouse.c" "ble_mouse.c" "voice.c" "provision.c"
    INCLUDE_DIRS "."
    PRIV_REQUIRES esp_driver_gpio esp_driver_i2c esp_driver_usb_serial_jtag
                  esp_timer esp_hid bt nvs_flash esp_wifi esp_netif
                  esp_https_server esp_http_server mbedtls spi_flash esp_hw_support
)
target_add_binary_data(${COMPONENT_LIB} "${CMAKE_SOURCE_DIR}/../.local/server.crt" TEXT)
target_add_binary_data(${COMPONENT_LIB} "${CMAKE_SOURCE_DIR}/../.local/server.key" TEXT)
target_add_binary_data(${COMPONENT_LIB} "${CMAKE_SOURCE_DIR}/../.local/pairing.txt" TEXT)
