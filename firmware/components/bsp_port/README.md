# 板级支持组件（bsp_port）来源说明

本目录不是完全自有的代码，迁移时从上游板级支持工程整合而来，按文件说明其来源：

| 文件 | 来源 | 许可证 |
| --- | --- | --- |
| `i2c_bsp.*`、`display_bsp.*` | 微雪官方产品仓库 [waveshareteam/ESP32-C6-Touch-AMOLED-2.16](https://github.com/waveshareteam/ESP32-C6-Touch-AMOLED-2.16) 的 `02_Example/ESP-IDF-v5.5.3/*/components/port_bsp`（微雪未在上游单独声明许可证，本仓库保留其板级适配用途） | 遵循上游声明 |
| `codec_bsp.*` | 同上，去掉了示例中的 PCM 播放/回放演示，只保留录音与编解码器初始化 | 遵循上游声明 |
| `power_bsp.*` | 同上 `components/pmicpower`，AXP2101 电源与电池状态，增加 `Axp2101_GetBatteryPercent()` | 遵循上游声明 |
| `xpowers/` | [XPowersLib](https://github.com/lewisxhe/XPowersLib)（AXP192/202/2101 等 PMIC 驱动），按上游文件头保留 MIT 许可证与版权声明 | MIT，Copyright (c) 2024 lewis he |
| `user_config.h` | 本工程重写：集中记录 2.16 板实测/官方示例使用的引脚映射 | Apache-2.0（本仓库） |

说明：

- 显示使用 `espressif/esp_lcd_sh8601`（QSPI），触摸使用
  `waveshare/esp_lcd_touch_cst9217`，LVGL 移植使用 `espressif/esp_lvgl_adapter`，
  均为构建时自动下载的托管组件，见根目录 `THIRD_PARTY_NOTICES.md`。
- 上游示例把 LCD CS / 触摸 INT 写作 5 / 15，但其可运行代码使用构造函数默认值
  15 / 5；本工程以官方示例代码实际使用的 15（CS）/ 5（INT）为准，并在
  `user_config.h` 中集中定义。
- `codec_board` 组件位于 `../codec_board`，许可证为 **Espressif Modified MIT**
  （仅限与 Espressif 产品配合使用），许可证全文随组件保留。
