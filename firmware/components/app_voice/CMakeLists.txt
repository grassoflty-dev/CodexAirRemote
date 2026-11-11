idf_component_register(SRCS "voice.c"
    INCLUDE_DIRS "."
    REQUIRES bsp_board app_busy app_mouse app_provision esp_driver_gpio esp_driver_i2c esp_driver_i2s
             esp_event esp_https_server esp_http_server esp_netif esp_timer esp_wifi mbedtls
             nvs_flash spi_flash)

# TLS certificate/key/pairing token are embedded into the voice component, which
# is where the TLS server implementation lives.
set(AIRREMOTE_LOCAL "${CMAKE_SOURCE_DIR}/../windows/.local")
foreach (asset server.crt server.key pairing.txt)
    if (NOT EXISTS "${AIRREMOTE_LOCAL}/${asset}")
        message(FATAL_ERROR "Missing ${AIRREMOTE_LOCAL}/${asset}. Run windows/Setup-Dev.ps1 first.")
    endif()
endforeach()
target_add_binary_data(${COMPONENT_LIB} "${AIRREMOTE_LOCAL}/server.crt" TEXT)
target_add_binary_data(${COMPONENT_LIB} "${AIRREMOTE_LOCAL}/server.key" TEXT)
target_add_binary_data(${COMPONENT_LIB} "${AIRREMOTE_LOCAL}/pairing.txt" TEXT)
