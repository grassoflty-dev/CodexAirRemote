idf_component_register(SRCS "identity.c" INCLUDE_DIRS "."
    PRIV_REQUIRES bootloader_support esp_hw_support mbedtls nvs_flash)
