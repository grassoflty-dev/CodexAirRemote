#include <stdio.h>
#include <freertos/FreeRTOS.h>
#include <driver/gpio.h>
#include <esp_err.h>
#include <esp_log.h>
#include <esp_sleep.h>
#include "power_bsp.h"
#include "XPowersLib.h"

const char *TAG = "axp2101";

static XPowersPMU axp2101;

static I2cMasterBus           *i2cbus_   = NULL;
static i2c_master_dev_handle_t i2cPMICdev = NULL;
static uint8_t                 i2cPMICAddress;

static int AXP2101_SLAVE_Read(uint8_t devAddr, uint8_t regAddr, uint8_t *data, uint8_t len) {
    int ret;
    uint8_t count = 3;
    do
    {
        ret = (i2cbus_->i2c_read_buff(i2cPMICdev, regAddr, data, len) == ESP_OK) ? 0 : -1;
        if (ret == 0)
            break;
        vTaskDelay(pdMS_TO_TICKS(100));
        count--;
    } while (count);
    return ret;
}

static int AXP2101_SLAVE_Write(uint8_t devAddr, uint8_t regAddr, uint8_t *data, uint8_t len) {
    int ret;
    uint8_t count = 3;
    do
    {
        ret = (i2cbus_->i2c_write_buff(i2cPMICdev, regAddr, data, len) == ESP_OK) ? 0 : -1;
        if (ret == 0)
            break;
        vTaskDelay(pdMS_TO_TICKS(100));
        count--;
    } while (count);
    return ret;
}


void Custom_PmicPortInit(I2cMasterBus *i2cbus,uint8_t dev_addr) {
    if(i2cbus_ == NULL) {
        i2cbus_ = i2cbus;
    }
    if(i2cPMICdev == NULL) {
        i2c_master_bus_handle_t BusHandle = i2cbus_->Get_I2cBusHandle();
        i2c_device_config_t     dev_cfg   = {};
        dev_cfg.dev_addr_length           = I2C_ADDR_BIT_LEN_7;
        dev_cfg.scl_speed_hz              = 100000;
        dev_cfg.device_address            = dev_addr;
        ESP_ERROR_CHECK(i2c_master_bus_add_device(BusHandle, &dev_cfg, &i2cPMICdev));
        i2cPMICAddress = dev_addr;
    }
    if (axp2101.begin(i2cPMICAddress, AXP2101_SLAVE_Read, AXP2101_SLAVE_Write)) {
        ESP_LOGI(TAG, "Init PMU SUCCESS!");
    } else {
        ESP_LOGE(TAG, "Init PMU FAILED!");
    }
    Custom_PmicRegisterInit();
}

/*
 * Board bring-up verified on the same hardware by
 * mfellner/esp32-playground components/board/board.cpp (docs/hardware.md):
 * only the panel-reset rail (AXP2101 ALDO3) is touched; charger and unrelated
 * rail registers keep their factory values. Writing DC1/ALDO1/ALDO2/ALDO4 and
 * VBUS limits (as the generic Waveshare example does) is unnecessary and was a
 * suspect for the black panel, so it is deliberately not done here.
 */
void Custom_PmicRegisterInit(void) {
    // ALDO3 voltage: reg 0x94 bits[4:0] = (mV - 500) / 100 -> 28 = 3300 mV.
    int aldo3 = axp2101.readRegister(0x94);
    if (aldo3 >= 0) {
        axp2101.writeRegister(0x94, (uint8_t)((aldo3 & 0xE0) | 28));
    }
    // Panel reset is a rail power cycle: on -> off -> on with 100 ms gaps.
    axp2101.enableALDO3();
    vTaskDelay(pdMS_TO_TICKS(100));
    axp2101.disableALDO3();
    vTaskDelay(pdMS_TO_TICKS(100));
    axp2101.enableALDO3();
}

void Axp2101_isChargingTask(void *arg) {
    for (;;) {
        vTaskDelay(pdMS_TO_TICKS(20000));
        ESP_LOGI(TAG, "isCharging: %s", axp2101.isCharging() ? "YES" : "NO");
        uint8_t charge_status = axp2101.getChargerStatus();
        if (charge_status == XPOWERS_AXP2101_CHG_TRI_STATE) {
            ESP_LOGI(TAG, "Charger Status: tri_charge");
        } else if (charge_status == XPOWERS_AXP2101_CHG_PRE_STATE) {
            ESP_LOGI(TAG, "Charger Status: pre_charge");
        } else if (charge_status == XPOWERS_AXP2101_CHG_CC_STATE) {
            ESP_LOGI(TAG, "Charger Status: constant charge");
        } else if (charge_status == XPOWERS_AXP2101_CHG_CV_STATE) {
            ESP_LOGI(TAG, "Charger Status: constant voltage");
        } else if (charge_status == XPOWERS_AXP2101_CHG_DONE_STATE) {
            ESP_LOGI(TAG, "Charger Status: charge done");
        } else if (charge_status == XPOWERS_AXP2101_CHG_STOP_STATE) {
            ESP_LOGI(TAG, "Charger Status: not charge");
        }
        ESP_LOGI(TAG, "getBattVoltage: %d mV", axp2101.getBattVoltage());
    }
}

void Axp2101_SetAldo3(uint8_t vol) {
    if(vol) {
        axp2101.enableALDO3();
    } else {
        axp2101.disableALDO3();
    }
}

void Axp2101_SetAldo2(uint8_t vol) {
    if(vol) {
        axp2101.enableALDO2();
    } else {
        axp2101.disableALDO2();
    }
}

bool Axp2101_IsBatteryConnected(void) {
    return axp2101.isBatteryConnect();
}

int Axp2101_GetBatteryPercent(void) {
    if (!axp2101.isBatteryConnect()) {
        return -1;
    }
    uint8_t percent = axp2101.getBatteryPercent();
    return percent <= 100 ? (int)percent : -1;
}

