# 第三方软件与许可证

本仓库自有源码采用 [Apache-2.0](LICENSE)。依赖的许可证独立适用，根许可证不会覆盖或更改第三方软件的许可证与版权。

本仓库包含两个工程（`windows/` Windows 辅助程序、`firmware/` ESP32-C6 固件）和一个归档工程（`firmware_s3/`，迁移前的 ESP32-S3 固件）。SDK、托管组件缓存、Python 环境、VB-CABLE 和 Codex 本体不随源码仓库提交。

## 固件依赖（`firmware/`）

### 工具链（Windows 全局安装）

| 软件 | 本项目版本 | 许可证与来源 |
| --- | --- | --- |
| ESP-IDF | 5.5.5 | 主要源码为 Apache-2.0；子组件与预编译库另有许可，见[官方版权清单](https://docs.espressif.com/projects/esp-idf/en/v5.5.5/esp32c6/COPYRIGHT.html)及 SDK 各文件声明 |
| RISC-V 工具链、OpenOCD、esptool 等 IDF 工具 | 随 ESP-IDF 5.5.5 安装 | 以各工具自身许可证为准 |

### 托管组件（构建时由 IDF Component Manager 下载到 `firmware/managed_components/`）

版本以 `firmware/dependencies.lock` 为准。

| 组件 | 版本 | 许可证与来源 |
| --- | --- | --- |
| lvgl/lvgl | 9.6.0~1 | MIT；[LVGL](https://github.com/lvgl/lvgl)。内置字体、图标及第三方库以各自许可为准 |
| espressif/esp_lcd_sh8601 | 1.0.0 | Apache-2.0；[组件](https://components.espressif.com/components/espressif/esp_lcd_sh8601) |
| waveshare/esp_lcd_touch_cst9217 | 1.0.4 | Apache-2.0；[组件](https://components.espressif.com/components/waveshare/esp_lcd_touch_cst9217) |
| espressif/esp_lvgl_adapter | 0.3.2 | Apache-2.0；[组件](https://components.espressif.com/components/espressif/esp_lvgl_adapter) |
| waveshare/qmi8658 | 2.0.2 | Apache-2.0；[组件](https://components.espressif.com/components/waveshare/qmi8658) |
| espressif/esp_codec_dev | 1.4.0 | Apache-2.0；[组件](https://components.espressif.com/components/espressif/esp_codec_dev) |
| espressif/esp_lcd_touch | 1.2.1 | Apache-2.0；按需自动引入 |
| espressif/button、esp_lv_decoder、esp_lv_fs、esp_mmap_assets、esp_new_jpeg、freetype、knob、libpng、qoi、zlib | 见 lock | 由 `esp_lvgl_adapter` 按需引入，组件级许可证以各组件声明为准（多数为 Apache-2.0，freetype 为 FTL/GPLv2 双许可） |

### 仓库内置组件（`firmware/components/`）

| 组件 | 来源 | 许可证 |
| --- | --- | --- |
| `board/`、`bsp_app/` | 本工程自有：C 接口封装与 LVGL 移植调整 | Apache-2.0 |
| `bsp_port/` 中 `i2c_bsp`、`display_bsp`、`codec_bsp`、`power_bsp` | 微雪官方 ESP32-C6-Touch-AMOLED-2.16 产品仓库示例的板级适配代码，详见 `firmware/components/bsp_port/README.md` | 遵循上游声明（微雪未单独声明许可证） |
| `bsp_port/xpowers/` | [XPowersLib](https://github.com/lewisxhe/XPowersLib) | MIT，Copyright (c) 2024 lewis he；许可证全文保留在 `XPowersLib.h` 文件头 |
| `codec_board/` | Espressif `codec_board` 组件（ES8311/ES7210 初始化） | **Espressif Modified MIT**（LicenseRef-Espressif-Modified-MIT，仅限与 Espressif 产品配合使用）；许可证全文见 `firmware/components/codec_board/LICENSE` |
| `firmware/docs/reference/esp_hid_device_example/` | ESP-IDF `examples/bluetooth/esp_hid/device` 参考副本，不参与构建 | `Unlicense OR CC0-1.0`，Copyright Espressif Systems |
| `firmware_s3/`（归档工程） | ESP32-S3-Touch-AMOLED-1.8 + Waveshare BSP 2.0.3 + LVGL 9.6 + esp_lvgl_port | Apache-2.0（微雪 BSP、QMI8658、esp_lvgl_port 等组件）；仅作历史参考，不再构建 |

## Windows 辅助程序与构建工具（`windows/`）

| 软件 | 本项目版本 | 许可证与来源 |
| --- | --- | --- |
| CPython / Tkinter / Tcl/Tk | Python 3.12 | PSF-2.0 及 Tcl/Tk 等上游条款；[Python 许可证](https://docs.python.org/3/license.html) |
| websockets | 15.0.1 | BSD-3-Clause；[项目](https://github.com/python-websockets/websockets) |
| pyserial | 3.5 | BSD；[项目与许可](https://github.com/pyserial/pyserial) |
| esptool | 5.2.0 | **GPL-2.0-or-later**；[源码及许可](https://github.com/espressif/esptool/tree/v5.2.0) |
| PyInstaller | 6.22.0 | GPL-2.0-or-later，包含允许分发所生成应用的特殊例外；[许可说明](https://pyinstaller.org/en/stable/license.html) |
| cryptography | 50.0.2，仅用于开发环境生成本机证书 | Apache-2.0 OR BSD-3-Clause；[项目](https://github.com/pyca/cryptography) |
| Codex app-server 协议 schema（`windows/vendor/codex-app-server-schema/`） | 随本机 Codex 版本导出 | 参考数据，仅用于开发对照；Codex 本体与协议版权归 OpenAI |

### 打包 EXE 时的许可

PyInstaller 的例外不会自动豁免其他依赖。当前辅助程序的打包配置会包含并调用 GPL-2.0-or-later 的 esptool。若对外发布该组合 EXE，应按 **GPL-3.0** 分发组合程序（esptool 的“或之后版本”许可允许选择 GPLv3，Apache-2.0 自有代码可并入 GPLv3 组合），随附许可证并向接收者提供完整对应源码、构建脚本与相应依赖源码；第三方原始版权与许可仍须保留。本仓库自有代码的 Apache-2.0 授权仍独立有效。

本次公开仓库仅发布源码，不发布包含本机密钥的 EXE 包或固件。仓库包含 GPLv3 文本供组合程序的许可说明使用；它不把独立的 Apache-2.0 固件源码重新授权为 GPL。

## 外部应用与驱动

- **Codex 桌面应用**由用户自行安装和登录。本项目通过其 App Server 与桌面听写控件工作，不包含 Codex 程序、模型或账号凭据。云端服务使用仍遵循其服务条款。
- **VB-CABLE**由用户从 [VB-Audio 官网](https://vb-audio.com/Cable/)单独下载，并遵循其许可；本仓库不重新分发该驱动。
- **ESP-IDF / VS Code / 工具链**均为本机全局安装，不在仓库中分发。

后续升级依赖时，应重新核对实际安装版本的许可；源文件中的声明优先于本摘要。
