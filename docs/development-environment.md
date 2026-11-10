# 开发环境与官方来源

本仓库只提交源码、脚本与文档。ESP-IDF、工具链、便携 IDE、受管组件、Python 虚拟环境等
**都可以从官方渠道获取，因此不入库**，克隆后按本文从官方源准备即可。

## 1. 不入库的目录

| 目录 | 内容 | 来源 |
| --- | --- | --- |
| `env/esp-idf/` | ESP-IDF v5.5.5 源码 | GitHub / EIM |
| `env/espressif/` | EIM 安装根：`tools/`（工具链）、`dist/`、Python 环境 | EIM / idf_tools |
| `firmware/managed_components/` | ESP-IDF Component Manager 下载的受管组件 | components.espressif.com |
| `firmware/build/`、`firmware/sdkconfig` | 构建产物与本机构建配置 | 本地生成 |
| `windows/.venv/`、`windows/.local/` | Python 虚拟环境与证书/备份等敏感材料 | 本地生成 |
| `tools/eim/`、`archive/` | 本地安装器与历史归档 | 本地 |

## 2. 最短准备步骤（克隆后）

```powershell
# 1) 准备 ESP-IDF 5.5.5 环境（二选一）
#    A. 已装 EIM：把本机安装复制到 env/（结构与 EIM 安装根一致）
robocopy "C:\Espressif-AirRemote\v5.5.5\esp-idf" ".\env\esp-idf" /E
robocopy "C:\Espressif\tools"                  ".\env\espressif\tools" /E
#    B. 全新机器：用 EIM 安装 ESP-IDF 5.5.5 到 env/ 下的 esp-idf 与 espressif

# 2) 激活环境（会自动调用 env/esp-idf/export.ps1，设置 PATH/ESP_ROM_ELF_DIR）
. .\env\activate.ps1

# 3) 构建固件；首次构建会自动从 components.espressif.com 下载受管组件
idf -C firmware build
```

Windows 辅助程序：

```powershell
cd windows
python -m venv .venv
.\.venv\Scripts\pip install -r requirements.txt
```

## 3. ESP-IDF 与工具链

| 项目 | 版本 | 官方链接 |
| --- | --- | --- |
| ESP-IDF | **v5.5.5** | 发布页 <https://github.com/espressif/esp-idf/releases/tag/v5.5.5> · 文档 <https://docs.espressif.com/projects/esp-idf/en/v5.5.5/> |
| ESP-IDF 入门（ESP32-C6） | v5.5.5 | <https://docs.espressif.com/projects/esp-idf/en/v5.5.5/esp32c6/get-started/index.html> |
| EIM（ ESP-IDF Installation Manager） | 官方安装器 | <https://dl.espressif.com/dl/eim/> · 说明 <https://docs.espressif.com/projects/esp-idf/en/v5.5.5/esp32c6/get-started/linux-macos-setup.html> |
| 工具链（riscv32-esp-elf 14.2.0 / cmake / ninja 等） | 随 IDF v5.5.5 | 由 `$IDF_PATH/tools/idf_tools.py install` 安装，本仓库放在 `env/espressif/tools/` |
| 本仓库 env 说明 | — | 见 [`../env/README.md`](../env/README.md) |

> `docs/firmware-audit.md` 记录了实际使用的 IDF 版本、驱动版本与验证结论。

## 4. VS Code 与 ESP-IDF 扩展

| 项目 | 值 | 官方链接 |
| --- | --- | --- |
| ESP-IDF 扩展 ID | `espressif.esp-idf-extension` | Marketplace <https://marketplace.visualstudio.com/items?itemName=espressif.esp-idf-extension> |
| 扩展源码 | espressif/vscode-esp-idf-extension | <https://github.com/espressif/vscode-esp-idf-extension> |

打开方式：用 VS Code 打开 `firmware/` 作为 ESP-IDF 工程，并让扩展指向仓库内环境：

- `idf.eimIdfJsonPath` → `env/eim_idf.json`（本机 setup 配置）
- `idf.currentSetup` → 选择 `env/eim_idf.json` 里记录的 setup
- 或者直接在终端里 `. .\env\activate.ps1` 后用命令行构建。

## 5. 受管组件（managed components）

以 `firmware/main/idf_component.yml` 与 `firmware/dependencies.lock` 为准（lock 为实际解析版本）。
组件页统一格式：`https://components.espressif.com/components/<namespace>/<name>`。

| 组件 | 版本 | 用途 | 组件页 |
| --- | --- | --- | --- |
| `espressif/esp_lcd_sh8601` | `^2.0.1`（锁定 2.0.1） | SH8601 AMOLED 面板驱动 | <https://components.espressif.com/components/espressif/esp_lcd_sh8601> |
| `waveshare/esp_lcd_touch_cst9217` | `^1.0.4`（锁定 1.0.4） | CST9217 触摸 | <https://components.espressif.com/components/waveshare/esp_lcd_touch_cst9217> |
| `espressif/esp_lvgl_adapter` | `~0.3.0`（锁定 0.3.2） | LVGL 适配层 | <https://components.espressif.com/components/espressif/esp_lvgl_adapter> |
| `lvgl/lvgl` | `^9.5.0`（锁定 9.6.0） | LVGL 图形库 | <https://components.espressif.com/components/lvgl/lvgl> |
| `espressif/esp_codec_dev` | `~1.4.0`（锁定 1.4.0） | ES8311/ES7210 编解码 | <https://components.espressif.com/components/espressif/esp_codec_dev> |
| `waveshare/qmi8658` | `^2.0.0`（锁定 2.0.2） | QMI8658 IMU | <https://components.espressif.com/components/waveshare/qmi8658> |
| `espressif/esp_lcd_touch` | 锁定 1.2.1 | 触摸通用层（由 CST9217 依赖） | <https://components.espressif.com/components/espressif/esp_lcd_touch> |
| `espressif/cmake_utilities` | 锁定 0.5.3 | 组件构建辅助 | <https://components.espressif.com/components/espressif/cmake_utilities> |

其余传递依赖（`espressif/button`、`esp_lv_fs`、`esp_lv_decoder`、`esp_mmap_assets`、`freetype`、`libpng`、`knob` 等）由
Component Manager 自动解析，完整版本见 `firmware/dependencies.lock`。

## 6. Windows 侧依赖

| 组件 | 版本/说明 | 官方链接 |
| --- | --- | --- |
| Python | **3.12.x**（注意：Python 3.13 移除了 `audioop`，本项目依赖它做 PCM 处理，勿用 3.13） | <https://www.python.org/downloads/release/python-3128/> |
| Python 包 | 见 `windows/requirements.txt` | 安装：`windows\.venv\Scripts\pip install -r windows\requirements.txt` |
| VB-CABLE（虚拟音频线） | 用于把系统音频路由给 Codex 听写 | <https://vb-audio.com/Cable/> |
| Codex 桌面版 | 听写目标应用 | <https://openai.com/codex/> · 下载页 <https://chatgpt.com/codex> |
| SenseVoice（可选，DSH 语音目标） | 本地 ASR，配置见 `docs/voice-targets.md` | <https://github.com/FunAudioLLM/SenseVoice> |

## 7. 相关文档

- [固件审计与版本对照](firmware-audit.md)
- [待实测清单](pending-hardware-validation.md)
- [语音目标配置（Codex / DSH）](voice-targets.md)
- [C6 迁移说明](firmware-c6-migration.md)
