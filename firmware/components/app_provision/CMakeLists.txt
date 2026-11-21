idf_component_register(SRCS "provision.c" INCLUDE_DIRS "." REQUIRES bsp_board app_ui app_busy app_identity rtc_board esp_wifi esp_driver_usb_serial_jtag esp_system nvs_flash)
