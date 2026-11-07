# 第三方软件与许可证

本仓库自有源码采用 [Apache-2.0](LICENSE)。依赖的许可证独立适用，根许可证不会覆盖或更改第三方软件的许可证与版权。SDK、组件缓存、Python 环境、VB-CABLE 和 Codex 本体未包含在本源码仓库中。

## 固件依赖

| 软件 | 本项目版本 | 许可证与来源 |
| --- | --- | --- |
| ESP-IDF | 5.5.5 | 主要源码为 Apache-2.0；子组件与预编译库另有许可，见[官方版权清单](https://docs.espressif.com/projects/esp-idf/en/v5.5.5/esp32s3/COPYRIGHT.html)及 SDK 各文件声明 |
| Waveshare ESP32-S3-Touch-AMOLED-1.8 BSP | 2.0.3 | Apache-2.0；[组件](https://components.espressif.com/components/waveshare/esp32_s3_touch_amoled_1_8/versions/2.0.3)，版权归微雪及相应贡献者 |
| Waveshare QMI8658 | 2.0.0 | Apache-2.0；[源码](https://github.com/waveshareteam/Waveshare-ESP32-components/tree/master/sensor/qmi8658) |
| LVGL | 9.6.0~1，锁定于 dependencies.lock | MIT；版权归 LVGL Kft 及贡献者；[源码与许可证](https://github.com/lvgl/lvgl)。内置字体、图标及第三方库以各自许可为准 |
| Espressif 托管组件 | 见 firmware/dependencies.lock | `cmake_utilities`、`esp_codec_dev`、`esp_io_expander`、`esp_io_expander_tca9554`、`esp_lcd_co5300`、`esp_lcd_panel_io_additions`、`esp_lcd_touch`、`esp_lcd_touch_cst816s`、`esp_lcd_touch_ft5x06`、`esp_lvgl_port` 的组件级许可证为 Apache-2.0；内含第三方文件以其文件声明为准 |

本工程通过官方 SDK API 和 BSP 集成硬件。ESP-IDF 的 BLE HID 示例提供了接口使用参考；该版本示例声明为 `Unlicense OR CC0-1.0`。未修改并提交上游 SDK 源码。重新分发 SDK、固件或所含字体等资源时，应保留相应的版权、许可证与 NOTICE，不能仅附上本仓库许可证。

## Windows 辅助程序与构建工具

| 软件 | 本项目版本 | 许可证与来源 |
| --- | --- | --- |
| CPython / Tkinter / Tcl/Tk | Python 3.12 | PSF-2.0 及 Tcl/Tk 等上游条款；[Python 许可证](https://docs.python.org/3/license.html) |
| websockets | 15.0.1 | BSD-3-Clause；[项目](https://github.com/python-websockets/websockets) |
| pyserial | 3.5 | BSD；[项目与许可](https://github.com/pyserial/pyserial) |
| esptool | 5.2.0 | **GPL-2.0-or-later**；[源码及许可](https://github.com/espressif/esptool/tree/v5.2.0) |
| PyInstaller | 6.22.0 | GPL-2.0-or-later，包含允许分发所生成应用的特殊例外；[许可说明](https://pyinstaller.org/en/stable/license.html) |
| cryptography | 50.0.2，仅用于开发环境生成本机证书 | Apache-2.0 OR BSD-3-Clause；[项目](https://github.com/pyca/cryptography) |

### 打包 EXE 时的许可

PyInstaller 的例外不会自动豁免其他依赖。当前辅助程序的打包配置会包含并调用 GPL-2.0-or-later 的 esptool。若对外发布该组合 EXE，应按 **GPL-3.0** 分发组合程序（esptool 的“或之后版本”许可允许选择 GPLv3，Apache-2.0 自有代码可并入 GPLv3 组合），随附许可证并向接收者提供完整对应源码、构建脚本与相应依赖源码；第三方原始版权与许可仍须保留。本仓库自有代码的 Apache-2.0 授权仍独立有效。

本次公开仓库仅发布源码，不发布包含本机密钥的 EXE 包或固件。仓库包含 GPLv3 文本供组合程序的许可说明使用；它不把独立的 Apache-2.0 固件源码重新授权为 GPL。

## 外部应用与驱动

- **Codex 桌面应用**由用户自行安装和登录。本项目通过 Windows UI Automation 操作其现有听写控件，不包含 Codex 程序、模型或账号凭据，也不提供未经官方支持的私有转录接口。云端服务使用仍遵循其服务条款。
- **VB-CABLE**由用户从 [VB-Audio 官网](https://vb-audio.com/Cable/)单独下载，并遵循其许可；本仓库不重新分发该驱动。

后续升级依赖时，应重新核对实际安装版本的许可；源文件中的声明优先于本摘要。
