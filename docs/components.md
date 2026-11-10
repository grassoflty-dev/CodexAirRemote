# 组件清单

本页按来源列出 Codex Air Remote 用到的全部组件，说明用途、版本、获取方式，以及是否需要放进仓库/VS Code 工作区。核心原则：

- **系统预装**：操作系统、Python、ESP-IDF、VS Code、VB-CABLE、Codex 桌面版等由使用者安装，不进入仓库。
- **自动下载**：Python 包由 `windows\Setup-Dev.ps1` 安装到 `windows/.venv`；ESP-IDF 托管组件由组件管理器在首次构建时下载到 `firmware/managed_components`。两者均已忽略，不提交。
- **随仓库**：辅助程序源码、固件源码、内置组件、脚本和文档。只有这些需要提交。

## Windows 全局组件

安装在工作区之外，供 Windows 辅助程序和固件构建共用。

| 组件 | 用途 | 版本 | 获取方式 | 是否放进工作区 |
| --- | --- | --- | --- | --- |
| Windows 11 x64 | 运行辅助程序；提供 WinRT 移动热点、蓝牙和 UI Automation | Windows 11 x64 | 预装 | 否 |
| 2.4 GHz 无线网卡 | 「电脑开热点」配网模式；需支持 Windows 移动热点 | 随硬件 | 预装/硬件 | 否 |
| Python | 创建 `windows/.venv`，运行辅助程序、测试和打包 | 3.12 x64（必须） | [python.org](https://www.python.org/downloads/) 安装 | 否 |
| ESP-IDF | 编译 C6 固件 | 5.5.5 | 乐鑫官方安装器或 EIM | 否 |
| IDF 工具链 | RISC-V GCC、CMake、Ninja、IDF Python 环境 | 随 5.5.5（RISC-V GCC 14.2.0，`esp-14.2.0_20260121`） | 安装器下载到 `C:\Espressif\tools` | 否 |
| IDF 激活脚本 | 为 `Build.ps1`/`Idf.ps1` 导入 `IDF_PATH` 等变量 | 随 5.5.5 | `C:\Espressif\tools\Microsoft.v5.5.5.PowerShell_profile.ps1` | 否 |
| VS Code | 编辑、任务、调试 | 当前稳定版 | 官方安装 | 否 |
| `ms-python.python` | Python 语言支持、解释器选择 | 最新 | VS Code 扩展市场 | 否（工作区仅推荐） |
| `ms-python.debugpy` | F5 调试 Python | 最新 | 扩展市场 | 否（工作区仅推荐） |
| `ms-vscode.cpptools` | 读取 `compile_commands.json`，C/C++ 导航 | 最新 | 扩展市场 | 否（工作区仅推荐） |
| `espressif.esp-idf-extension` | menuconfig、烧录、串口监视等可选入口 | 2.3.0 | 扩展市场 | 否（脚本不依赖） |
| VB-Audio VB-CABLE | 虚拟声卡；板端 PCM → CABLE Input，Codex 从 CABLE Output 取音 | 当前版本 | [vb-audio.com](https://vb-audio.com/Cable/) 安装 | 否 |
| Codex 桌面版 | 提供桌面听写控件；辅助程序通过 UI Automation 操作 | 已登录桌面版 | 官方渠道安装 | 否 |
| EIM（`eim.exe`） | Espressif IDF 安装管理器；本机保留在 `tools/eim/` | 随下载 | 手动放入，已忽略 | 否（本地工具，不提交） |

## Windows 项目组件

由仓库脚本创建或下载，位于 `windows/` 内。

| 组件 | 用途 | 版本 | 获取方式 | 是否放进工作区 |
| --- | --- | --- | --- | --- |
| `websockets` | TLS WebSocket 客户端 | 15.0.1 | `Setup-Dev.ps1` 自动安装 | 否（`.venv` 已忽略，由脚本重建） |
| `pyserial` | 串口枚举与 USB 配网 | 3.5 | 同上 | 否 |
| `esptool` | 读 Flash、写镜像；打包进 EXE | 5.2.0 | 同上 | 否 |
| `pyinstaller` | 打包 onedir EXE | 6.22.0 | `requirements-dev.txt` 自动安装 | 否 |
| `cryptography` | 生成 RSA 证书与私钥 | 50.0.2 | 同上 | 否 |
| `windows/.venv/` | 项目 Python 3.12 环境 | — | `Setup-Dev.ps1` 创建 | 否（已忽略） |
| `windows/.local/` | 证书、私钥、配对令牌、网络配置、备份、日志 | — | `Setup-Dev.ps1`/烧录时生成 | 否（已忽略，敏感） |
| `windows/app/` | PyInstaller 输出（EXE + `_internal`） | — | `Build-App.ps1` 生成 | 否（已忽略） |
| `windows/build/` | PyInstaller 中间产物与旧版本备份 | — | 打包时生成 | 否（已忽略） |
| `windows/vendor/codex-app-server-schema/` | Codex app-server 协议 schema 参考 | 随仓库 | Git | 是（只读参考） |
| `windows/host/`、`tools/`、`tests/` | 辅助程序源码、初始化脚本、测试 | 随仓库 | Git | 是 |
| `windows/*.ps1`、`*.cmd` | 环境、打包、启动、烧录入口 | 随仓库 | Git | 是 |

## 固件全局工具链

| 组件 | 用途 | 版本 | 获取方式 | 是否放进工作区 |
| --- | --- | --- | --- | --- |
| ESP-IDF | 构建系统、驱动、Wi-Fi/BLE/HTTPS/mbedTLS | 5.5.5 | 预装 | 否 |
| RISC-V GCC | 编译 ESP32-C6 代码 | 14.2.0（`esp-14.2.0_20260121`） | 随 ESP-IDF 安装 | 否 |
| CMake + Ninja | 生成并执行构建 | 随 ESP-IDF | 随 ESP-IDF 安装 | 否 |
| IDF Python 环境 | 运行 `idf.py`、组件管理器 | 随 ESP-IDF（`IDF_PYTHON_ENV_PATH`） | 随 ESP-IDF 安装 | 否 |
| 内置 USB-Serial/JTAG 驱动 | 控制台与配网串口 | Windows 11 自带 | 预装 | 否 |
| VS Code ESP-IDF 扩展 | 可选的图形构建/烧录入口 | 2.3.0 | 扩展市场 | 否（`Build.ps1` 不依赖） |

固件构建**不**需要仓库外的 Python 包；`Build.ps1` 只借用 `windows/.venv` 中的 `cryptography` 生成配对材料。烧录由 Windows 辅助程序内的 esptool 5.2.0 完成。

## 固件托管组件

声明在 `firmware/main/idf_component.yml`，首次构建自动下载到 `firmware/managed_components`，版本锁定在 `firmware/dependencies.lock`。缓存目录已忽略，不提交。

| 组件 | 用途 | 版本（解析结果） | 获取方式 | 是否放进工作区 |
| --- | --- | --- | --- | --- |
| `lvgl/lvgl` | LVGL 9 图形库、字体、控件 | 9.6.0~1 | 组件管理器自动下载 | 否（构建时生成） |
| `espressif/esp_lcd_sh8601` | SH8601 AMOLED 面板驱动 | 1.0.0 | 同上 | 否 |
| `waveshare/esp_lcd_touch_cst9217` | CST9217 触摸驱动 | 1.0.4 | 同上 | 否 |
| `espressif/esp_lvgl_adapter` | LVGL 显示/触摸适配、任务与锁 | 0.3.2 | 同上 | 否 |
| `waveshare/qmi8658` | QMI8658 IMU 驱动 | 2.0.2 | 同上 | 否 |
| `espressif/esp_codec_dev` | ES8311/ES7210 统一音频接口 | 1.4.0 | 同上 | 否 |
| 传递依赖 | `esp_lcd_touch`、`cmake_utilities`、`esp_lv_decoder`、`esp_lv_fs`、`freetype`、`libpng`、`zlib` 等 | 见 `dependencies.lock` | 随上述组件自动解析 | 否 |

升级托管组件时修改 `idf_component.yml` 的版本约束，重新构建并把新的 `dependencies.lock` 一起提交；同时核对 [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) 中的许可证说明。

## 固件内置组件

随仓库提交，由 ESP-IDF 直接编译。

| 组件 | 用途 | 版本 | 获取方式 | 是否放进工作区 |
| --- | --- | --- | --- | --- |
| `firmware/main/` | UI、鼠标、BLE HID、语音、USB 配网、内嵌证书 | 随仓库 | Git | 是 |
| `firmware/components/bsp_port/` | I2C、SH8601 QSPI、CST9217、AXP2101（XPowersLib）、ES8311/ES7210 | 随仓库（板级移植） | Git | 是 |
| `firmware/components/bsp_app/` | `esp_lv_adapter` 初始化、LVGL 显示/触摸注册、锁 | 随仓库 | Git | 是 |
| `firmware/components/board/` | 对 `main/` 暴露的 C 接口（`board_init`、显示、锁、I2C、亮度、电池、麦克风） | 随仓库 | Git | 是 |
| `firmware/components/codec_board/` | Espressif ES8311/ES7210 初始化组件（Vendor 化） | 随仓库 | Git | 是 |
| `firmware/docs/reference/esp_hid_device_example/` | ESP-IDF BLE HID 设备示例，仅供接口参考，不参与编译 | 随仓库 | Git | 是（参考） |
| `firmware/partitions.csv`、`sdkconfig.defaults`、`CMakeLists.txt` | 分区、默认配置、目标芯片 | 随仓库 | Git | 是 |
| `firmware/Build.ps1`、`Idf.ps1` | 构建入口与 `idf.py` 包装 | 随仓库 | Git | 是 |

## 归档工程

| 组件 | 用途 | 版本 | 获取方式 | 是否放进工作区 |
| --- | --- | --- | --- | --- |
| `archive_local/firmware_s3/` | 迁移前的 ESP32-S3 固件（**不在仓库内**，本机归档），不参与当前构建 | ESP-IDF 5.5.5；Waveshare BSP 2.0.3；LVGL 9.6；QMI8658 2.0.0 | Git 归档 | 是（只读参考，不构建） |
| `archive_local/firmware_s3/managed_components/`、`build/`、`sdkconfig` | 旧工程构建产物，已忽略 | — | 若编译旧工程时生成 | 否 |
| `tools/eim/eim.exe` | Espressif IDF 安装管理器，本地保留 | 随下载 | 手动放入 | 否（已忽略） |

归档工程不代表当前受支持路径。C6 与 S3 的差异、迁移步骤和待验证项见 [firmware-c6-migration.md](firmware-c6-migration.md)。
