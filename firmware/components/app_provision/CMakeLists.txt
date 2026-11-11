idf_component_register(SRCS "provision.c" INCLUDE_DIRS "." REQUIRES bsp_board app_ui rtc_board esp_wifi esp_driver_usb_serial_jtag nvs_flash)
