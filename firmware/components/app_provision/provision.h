#pragma once

#include "esp_err.h"
#include "esp_wifi.h"

esp_err_t provision_start(void);
esp_err_t provision_read(wifi_config_t *config);
void provision_report_board(unsigned readiness);
