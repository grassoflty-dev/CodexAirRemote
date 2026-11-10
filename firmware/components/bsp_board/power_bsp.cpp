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
 * Panel bring-up mirrors the vendor 09_LVGL_V9_Test example
 * (02_Example/ESP-IDF-v5.5.3/09_LVGL_V9_Test/components/pmicpower/power_bsp.cpp):
 * every rail the AMOLED module can draw from (DC1 and ALDO1/2/3/4) is set to
 * 3.3 V and explicitly enabled. Touching only the ALDO3 reset rail left the
 * panel dark even though the SH8601 accepted its initialization commands.
 */
void Custom_PmicRegisterInit(void) {
    ESP_LOGI(TAG, "rails before: DC1=%dmV(%d) ALDO1=%dmV(%d) ALDO2=%dmV(%d) ALDO3=%dmV(%d) ALDO4=%dmV(%d)",
             axp2101.getDC1Voltage(), axp2101.isEnableDC1(),
             axp2101.getALDO1Voltage(), axp2101.isEnableALDO1(),
             axp2101.getALDO2Voltage(), axp2101.isEnableALDO2(),
             axp2101.getALDO3Voltage(), axp2101.isEnableALDO3(),
             axp2101.getALDO4Voltage(), axp2101.isEnableALDO4());

    axp2101.setVbusCurrentLimit(XPOWERS_AXP2101_VBUS_CUR_LIM_2000MA);

    if (axp2101.getDC1Voltage() != 3300) axp2101.setDC1Voltage(3300);
    if (axp2101.getALDO1Voltage() != 3300) axp2101.setALDO1Voltage(3300);
    if (axp2101.getALDO2Voltage() != 3300) axp2101.setALDO2Voltage(3300);
    if (axp2101.getALDO3Voltage() != 3300) axp2101.setALDO3Voltage(3300);
    if (axp2101.getALDO4Voltage() != 3300) axp2101.setALDO4Voltage(3300);

    axp2101.enableDC1();
    axp2101.enableALDO1();
    axp2101.enableALDO2();
    axp2101.enableALDO4();

    axp2101.setPrechargeCurr(XPOWERS_AXP2101_PRECHARGE_50MA);
    axp2101.setChargerConstantCurr(XPOWERS_AXP2101_CHG_CUR_500MA);
    axp2101.setChargerTerminationCurr(XPOWERS_AXP2101_CHG_ITERM_50MA);

    ESP_LOGI(TAG, "rails: DC1=%d ALDO1=%d ALDO2=%d ALDO3=%d ALDO4=%d",
             axp2101.isEnableDC1(), axp2101.isEnableALDO1(), axp2101.isEnableALDO2(),
             axp2101.isEnableALDO3(), axp2101.isEnableALDO4());

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


/* TEMP panel bisect: report whether the panel rail is actually enabled. */
bool Axp2101_IsAldo3Enabled(void)
{
    return axp2101.isEnableALDO3();
}
