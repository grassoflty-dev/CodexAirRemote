#pragma once

#include <stdbool.h>

#include "i2c_bsp.h"

void Custom_PmicPortInit(I2cMasterBus *i2cbus, uint8_t dev_addr);
void Custom_PmicRegisterInit(void);
void Axp2101_isChargingTask(void *arg);

void Axp2101_SetAldo2(uint8_t vol);
void Axp2101_SetAldo3(uint8_t vol);

/* AXP2101 battery state used by the on-screen battery indicator. */
bool Axp2101_IsBatteryConnected(void);
int Axp2101_GetBatteryPercent(void);

