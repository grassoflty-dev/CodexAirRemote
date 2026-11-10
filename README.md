# Codex Air Remote

Codex Air Remote 把一块带触摸屏的 ESP32 开发板变成 Codex 的无线输入设备：板载麦克风把语音送到 Windows，再由 **Codex 桌面听写**（默认）或 **DeepSeek Harness 语音输入**（实验，可在辅助程序内切换）转成文字；切到陀螺仪模式后，开发板又变成一只蓝牙空中鼠标。仓库包含两个可以独立构建、运行时互相配合的软件：

- **Windows 辅助程序**（`windows/`）：Tkinter 图形界面、USB 烧录与 Wi-Fi 配网、VB-CABLE 虚拟麦克风音频路由、可切换语音目标（Codex / DeepSeek Harness）、Windows 2.4 GHz 热点、蓝牙鼠标配对。
- **ESP32-C6 固件**（`firmware/`）：面向微雪 ESP32-C6-Touch-AMOLED-2.16 的触屏界面、蓝牙 HID 鼠标、Wi-Fi/HTTPS/WebSocket 语音链路、USB Serial/JTAG 配网。

本仓库**唯一活动固件是 `firmware/`**（Waveshare **ESP32-C6**-Touch-AMOLED-2.16，SH8601 480×480，ESP-IDF v5.5.5）。迁移前的 ESP32-S3 工程**已移出仓库**，仅在本机 `archive_local/` 保留归档，不参与构建、也不随仓库分发。C6 版本已在实机上验证到启动、显示/触摸、语音握手与音频帧，鼠标/按键与完整语音 E2E 的待实测项见 [`docs/pending-hardware-validation.md`](docs/pending-hardware-validation.md)；迁移前的本机验证记录见 [TEST_REPORT.md](TEST_REPORT.md)。

这是独立的社区源码项目，不隶属于 OpenAI、乐鑫或微雪。仓库只提供源码、脚本和文档，不包含预编译固件、EXE、模型、驱动或任何本机密钥。

> **换电脑继续开发？** 先读 [项目总结与换电脑继续开发指南](docs/project-summary-and-usage.md)
> （项目现状、env/ 迁移、重新配网/BLE 配对、首次跑通流程）；环境版本与官方下载链接见
> [开发环境与官方来源](docs/development-environment.md)。

## 硬件

目标板为微雪 **ESP32-C6-Touch-AMOLED-2.16**（电池款）：

| 项目 | 规格 |
| --- | --- |
| MCU | ESP32-C6，单核 RISC-V，最高 160 MHz，512 KB SRAM，无 PSRAM |
| Flash | 16 MB，固定分区表 |
| 显示 | 480×480 AMOLED，SH8601，QSPI（CS=GPIO15、CLK=GPIO0、D0..D3=GPIO1..4） |
| 触摸 | CST9217，I2C（SCL=GPIO7、SDA=GPIO8、RST=GPIO11、INT=GPIO5、地址 0x5A） |
| 电源 | AXP2101（地址 0x34），带电池检测；AMOLED 复位靠 AXP2101 ALDO3 断电 |
| 音频 | ES8311 扬声器 + ES7210 麦克风，I2S TDM（MCLK=19、BCLK=20、WS=22、DIN=21、DOUT=23） |
| 传感器 | QMI8658 六轴 IMU（I2C） |
| USB | 原生 USB-Serial/JTAG，VID:PID `303A:1001` |
| 按键 | 无硬件复位键 |

完整引脚表见 [docs/firmware-c6-migration.md](docs/firmware-c6-migration.md)。

## 目录结构

| 路径 | 内容 |
| --- | --- |
| `CodexAirRemote.code-workspace` | VS Code 多根工作区，包含 `windows` 与 `firmware` 两个根 |
| `windows/host/` | 辅助程序源码：界面、烧录、音频服务、Codex 适配、虚拟声卡、热点 |
| `windows/tools/init_pairing.py` | 生成本机 TLS 证书、私钥和配对令牌 |
| `windows/tests/` | `unittest` 测试（配对材料初始化） |
| `windows/.venv/` | 项目内 Python 3.12 虚拟环境，由 `Setup-Dev.ps1` 创建，已忽略 |
| `windows/.local/` | 每台电脑本地生成：`server.crt`、`server.key`、`pairing.txt`、`network.json`、备份与日志，已忽略 |
| `windows/app/` | PyInstaller 打包输出（`CodexAirRemote.exe` + `_internal`），已忽略 |
| `windows/build/` | PyInstaller 中间产物，已忽略 |
| `windows/vendor/codex-app-server-schema/` | Codex app-server 协议 JSON schema 参考 |
| `windows/` 根脚本 | `Setup-Dev.ps1`、`Build-App.ps1`、`Companion.cmd`、`Flash.cmd` |
| `firmware/main/` | `app_main.c`（UI 与主逻辑）、`air_mouse.c`、`ble_mouse.c`、`voice.c`、`provision.c` |
| `firmware/components/` | 板级支持：`bsp_port`、`bsp_app`、`board`、`codec_board` |
| `firmware/docs/reference/` | ESP-IDF BLE HID 设备示例，仅作接口参考 |
| `firmware/Build.ps1`、`Idf.ps1` | 固件构建入口、`idf.py` 子命令包装（menuconfig/monitor/fullclean） |
| `firmware/partitions.csv`、`sdkconfig.defaults`、`CMakeLists.txt` | 分区表、默认配置、目标芯片（`esp32c6`） |
| `firmware/build/`、`firmware/managed_components/` | 构建产物与托管组件缓存，已忽略 |
| `archive_local/firmware_s3/` | 迁移前的 S3 工程（**不在仓库内**，仅本机归档） |
| `tools/eim/eim.exe` | Espressif IDF 安装管理器，本地保留，已忽略 |
| `docs/` | 组件清单与 C6 迁移说明 |
| `LICENSE`、`NOTICE`、`THIRD_PARTY_NOTICES.md`、`TEST_REPORT.md` | 许可、版权声明与验证记录 |

## 组件需求

完整版本与获取方式见 [docs/components.md](docs/components.md)。核心原则：SDK、虚拟声卡、Codex 和 Python 运行时都装在系统里；Python 依赖和托管组件由脚本自动下载；只有源码和文档进仓库。

### 本地未提交内容

下面这些目录只存在于本机，已被 `.gitignore` 忽略，不需要提交：

| 路径 | 说明 |
| --- | --- |
| `windows/.venv/`、`windows/.local/`、`windows/app/`、`windows/build/` | Python 环境、配对材料与运行时数据、打包输出、打包中间产物 |
| `firmware/build/`、`firmware/managed_components/`、`firmware/sdkconfig` | 固件构建产物、托管组件缓存、生成的配置 |
| `archive_local/` | 本机归档目录（含 S3 旧工程的构建产物），已被 `.gitignore` 忽略 |
| `tools/eim/eim.exe` | 本机 ESP-IDF 安装管理器（二进制，不提交） |
| `archive/` | 迁移时从旧 Codex 工作树整理出的历史资料（旧 ASR 测试素材、旧脚本、临时构建）；与两个项目无关，确认不需要后可直接删除 |
| `.local/`（仓库根） | 其他本机工具可能生成的临时目录，已忽略 |

### Windows 全局组件（不进仓库）

| 组件 | 版本/要求 | 获取方式 | 用途 |
| --- | --- | --- | --- |
| Windows 11 x64 | — | 系统预装 | 运行辅助程序；WinRT 移动热点、蓝牙与 UI Automation |
| 支持 2.4 GHz 移动热点的无线网卡 | — | 硬件 | 「电脑开热点」配网模式；需要可共享的上网连接 |
| Python 3.12 x64 | 必须 3.12 | [python.org](https://www.python.org/downloads/) | 创建 `windows/.venv`；3.13 已移除 `audioop`，不能用于本项目 |
| ESP-IDF | 5.5.5 | 乐鑫官方安装器 / `tools/eim/eim.exe` | 编译 C6 固件 |
| IDF 工具链与激活脚本 | 随 5.5.5 | 安装器生成 | 默认位置 `C:\Espressif-AirRemote\v5.5.5\esp-idf`、`C:\Espressif\tools`，激活脚本 `C:\Espressif\tools\Microsoft.v5.5.5.PowerShell_profile.ps1` |
| VS Code + 扩展 | — | 扩展市场 | `ms-python.python`、`ms-python.debugpy`、`ms-vscode.cpptools`、`espressif.esp-idf-extension`（2.3.0） |
| VB-Audio VB-CABLE | 当前版本 | [vb-audio.com](https://vb-audio.com/Cable/) | 虚拟声卡；把 CABLE Output 设为默认输入 |
| Codex 桌面版 | 已安装并登录 | 官方渠道 | 提供桌面听写按钮；辅助程序用 UI Automation 操作它 |

### Windows 项目内组件（自动获取，不入仓库）

| 组件 | 版本 | 获取方式 |
| --- | --- | --- |
| `websockets` | 15.0.1 | `Setup-Dev.ps1` 安装到 `windows/.venv` |
| `pyserial` | 3.5 | 同上 |
| `esptool` | 5.2.0 | 同上；同时被打包进 EXE 供图形烧录调用 |
| `pyinstaller` | 6.22.0 | 开发依赖，仅打包时使用 |
| `cryptography` | 50.0.2 | 开发依赖，仅生成证书时使用 |

`windows/.venv`、`windows/.local`、`windows/app`、`windows/build` 都在 `.gitignore` 中，不需要也不应该提交。

### 固件组件

| 类别 | 组件 | 版本 | 获取方式 |
| --- | --- | --- | --- |
| 工具链 | ESP-IDF | 5.5.5 | 系统预装 |
| 托管组件 | `lvgl/lvgl` | `^9.5`（实解析 9.6.0~1） | 首次构建由组件管理器下载到 `firmware/managed_components` |
| 托管组件 | `espressif/esp_lcd_sh8601` | `^1.0.0`（1.0.0） | 同上 |
| 托管组件 | `waveshare/esp_lcd_touch_cst9217` | `^1.0.4`（1.0.4） | 同上 |
| 托管组件 | `espressif/esp_lvgl_adapter` | `~0.3.0`（0.3.2） | 同上 |
| 托管组件 | `waveshare/qmi8658` | `^2.0.0`（2.0.2） | 同上 |
| 托管组件 | `espressif/esp_codec_dev` | `~1.4.0`（1.4.0） | 同上 |
| 内置组件 | `bsp_port`（含 XPowersLib）、`bsp_app`、`board`、`codec_board` | 随仓库 | 直接编译 |

托管组件在首次构建时联网下载，缓存目录不提交；实际解析版本锁定在 `firmware/dependencies.lock`。

## 从零开始

以下命令均在仓库根目录或指定目录下执行，路径以本机安装位置为准。

### 1. 准备全局组件

1. 安装 Windows 11 驱动、Python 3.12（64 位）和 VS Code，并在 VS Code 中安装上表列出的扩展。
2. 用乐鑫官方安装器（或仓库内 `tools/eim/eim.exe`）安装 **ESP-IDF 5.5.5**，并确认激活脚本存在：`C:\Espressif\tools\Microsoft.v5.5.5.PowerShell_profile.ps1`。
3. 安装 VB-CABLE，并在「Windows 声音设置」中把 **CABLE Output** 设为默认输入设备。
4. 安装并登录 Codex 桌面版。

### 2. 初始化 Windows 开发环境

```powershell
cd windows
powershell -ExecutionPolicy Bypass -File .\Setup-Dev.ps1
```

脚本会：校验 Python 是否为 3.12 → 创建 `windows/.venv` → 安装 `host\requirements-dev.txt` → 运行 `tools\init_pairing.py` 生成 `windows/.local` 中的证书、私钥和配对令牌。首次运行需要联网下载依赖。

- Python 不在 PATH 时：`.\Setup-Dev.ps1 -Python "C:\Path\To\python.exe"`
- 环境已完整、只想检查配对材料时：`.\Setup-Dev.ps1 -SkipDependencyInstall`

配对材料每个仓库/电脑只生成一次；已存在时保留，不完整或证书与私钥不匹配时会报错停止，不会自动覆盖。

### 3. 打包 Windows 程序

```powershell
cd windows
powershell -ExecutionPolicy Bypass -File .\Build-App.ps1
```

PyInstaller 以 **onedir** 方式输出到 `windows/app`：入口 `app\CodexAirRemote.exe`，运行库在 `app\_internal`。中间产物在 `windows/build/pyinstaller`。不要单独移动 EXE，必须保留整个目录。

### 4. 编译固件

```powershell
powershell -ExecutionPolicy Bypass -File .\firmware\Build.ps1
```

`Build.ps1` 依次完成：激活 ESP-IDF 5.5.5 → 用 `windows/.venv` 中的 Python 准备配对材料 → `idf.py build` → 根据 `build/flasher_args.json` 生成带 SHA-256 的 `build/airremote-release.json`。

首次构建会下载托管组件，耗时且消耗流量。产物：

| 文件 | 烧录地址 |
| --- | --- |
| `firmware/build/bootloader/bootloader.bin` | `0x0` |
| `firmware/build/partition_table/partition-table.bin` | `0x8000` |
| `firmware/build/ota_data_initial.bin` | `0x10d000` |
| `firmware/build/codex_air_remote.bin` | `0x200000` |
| `firmware/build/airremote-release.json` | SHA-256 清单，烧录前校验 |

固件会把 `windows/.local` 中的证书、私钥和配对令牌编进镜像，因此**固件构建依赖 Windows 侧已经生成配对材料**；换电脑后必须重新生成并重新烧录两侧。

### 5. 烧录与配网

用支持数据传输的 USB-C 线连接开发板，只接这一块板，然后任选一种入口：

- 打开 `windows\Companion.cmd`（或 `app\CodexAirRemote.exe`），点击「烧录开发板」。
- 在 `windows` 目录运行 `.\Flash.cmd`。

烧录流程：识别唯一的 Espressif USB 设备（`303A:1001`）→ 校验 16 MB Flash 与 MAC → 备份原始 Flash 到 `windows/.local/backups` → 按固定地址写入并校验 → 通过 USB Serial/JTAG 写入 Wi-Fi 配置 → 启动后台服务 → 尝试配对蓝牙鼠标。

配网有两种模式：默认由电脑开启 **2.4 GHz 热点**并自动配置；也可以选择已有 2.4 GHz Wi-Fi 并填写 SSID 与 WPA2 密码（1–32 字节 / 8–63 字节）。首次备份 16 MB 可能需要几分钟，之后烧录会复用已校验的备份。

## 使用

### 屏幕上的四个按钮

屏幕上有 **Voice、Gyro、A、B** 四个触摸图标，两种模式互斥。

- **Voice**：点 Voice 开始录音，等板上显示 `Recording` 后对着开发板说话。默认目标是 Codex 桌面听写（点 **A** 请求转录并发送，点 **B** 取消听写）；也可在「烧录开发板」窗口把语音目标切到 **DeepSeek Harness 语音输入**（停止后文字进入 DSH 草稿，由你在 DSH 中发送）。A 在录音就绪后启用；B 在连接电脑阶段也可取消。录音满 60 秒未点 A 会自动取消。显示 `Codex send requested` 表示已触发目标应用按钮，最终结果请到对应应用中查看。
- **Gyro**：点 Gyro 开启陀螺仪鼠标，握住设备静止约一秒完成校准，再转动手腕移动光标。**A** 是鼠标左键（轻点单击、连续轻点双击、按住拖拽并在松手时释放），**B** 是鼠标右键。再次点 Gyro 关闭。

鼠标通过蓝牙直接连接 Windows；语音通过加密的 Wi-Fi 连接把板载录音送到电脑。屏幕顶部显示 BLE 连接状态与 AXP2101 电量；25 秒无操作后自动降低亮度，触摸后恢复。

### 语音链路

辅助程序把板端 PCM 只送到 **CABLE Input**，并检查 **CABLE Output** 是否为 Windows 默认录音设备。语音目标可在辅助程序里切换：

- **Codex（默认）**：开始前把目标 Codex 对话放在前台；辅助程序按控件名称操作该对话的听写按钮。第一次使用听写时，如 Codex 弹出麦克风权限提示，请在 Codex 中处理。
- **DeepSeek Harness（实验）**：DSH 桌面版启用内置的「录音输入」插件、准备好本机 SenseVoice 模型，并在插件详情把输入设备选为 **CABLE Output**；DSH 从 CABLE 读取板载音频并自行转写。识别结果进入会话草稿，不自动发送。详见 [docs/voice-targets.md](docs/voice-targets.md)。

### 网络

- **热点模式**：辅助程序用 Windows 移动热点开一个 2.4 GHz 网络，SSID 形如 `AirRemote-XXXXXX`，密码由本机配对令牌派生；板端连接后通过 UDP 47682 发现、WSS 47683 传输。热点需要电脑有可共享的上网连接。
- **局域网模式**：板端与电脑连接同一个 2.4 GHz Wi-Fi，路由器需允许设备互访。

两种模式都不经过云端中转：板端到电脑这一段只在局域网内传输，电脑上的 Codex 桌面听写再按它自己的方式处理音频。

### 蓝牙鼠标

烧录完成后辅助程序会尝试自动配对。若 Windows 弹出配对提示，确认 **Codex Air Remote**；未自动完成时，点辅助程序里的「蓝牙设置」，在 Windows 蓝牙设置中添加该设备。

配对后的用法：

1. 板子平放在桌面，点屏幕上的 **Gyro**；状态行显示 `Calibrating - hold the board still`。
2. **保持静止约 1 秒**（零偏校准约 150 个 4 ms 样本），状态行变为 `Mouse active  /  A left, B right`。
3. 缓慢倾斜板子移动光标；**A = 左键、B = 右键**。再点一次 Gyro 退出鼠标模式。

BLE 的 CCCD（订阅）状态会写入 NVS，并在重连时自动恢复。也就是说**只需配对一次**：之后断电重启、甚至重刷固件（不擦 NVS）都不必重新配对。若曾经用旧固件配对过、重启后光标不动，删除设备重新配对一次即可（详见 [docs/display-bringup-notes.md](docs/display-bringup-notes.md)）。

## 日常开发

### VS Code 工作区

用「文件 → 从文件打开工作区」打开根目录的 `CodexAirRemote.code-workspace`。工作区有两个根：`windows` 和 `firmware`，各自的 `.vscode` 提供该根下的任务与调试配置；直接打开项目根目录不会自动获得这些任务。

| 所在文件夹 | 任务 | 作用 |
| --- | --- | --- |
| `windows` | 辅助程序：打包 EXE | 默认构建任务，等价于 `Build-App.ps1` |
| `windows` | 辅助程序：准备开发环境 | 等价于 `Setup-Dev.ps1` |
| `windows` | 辅助程序：运行源码界面 | 用 `.venv` 直接运行 `host/desktop.py` |
| `windows` | 辅助程序：离线协议检查（模拟设备） | 运行 `host/offline_check.py` |
| `windows` | 辅助程序：单元测试 | `python -m unittest discover -s tests -v` |
| `windows` | 辅助程序：烧录/配网 | 调用 `Flash.cmd` |
| `firmware` | 固件：编译 | 默认构建任务，等价于 `firmware/Build.ps1` |
| `firmware` | 固件：menuconfig | 通过 `Idf.ps1` 打开配置界面 |
| `firmware` | 固件：串口监视 | 通过 `Idf.ps1` 运行 `idf.py monitor` |
| `firmware` | 固件：全量清理 | 通过 `Idf.ps1` 运行 `idf.py fullclean` |

多根工作区下按 `Ctrl+Shift+B` 会要求选择使用哪个文件夹的默认构建任务。

### 调试

- 「辅助程序：界面（源码）」：启动 `host/desktop.py`，直接改代码后重启即可看到效果。
- 「辅助程序：后台服务（源码）」：启动 `host/companion.py`，可在其中设置断点；需要已完成配网并开启服务设置。

源码界面启动的服务使用源码，打包后的 EXE 使用包内代码。修改前先在界面里「停止服务」并关闭旧窗口；打包前也要关闭现有 EXE 并停止服务，避免 Windows 占用文件。

### 测试

```powershell
cd windows
.\.venv\Scripts\python.exe -m unittest discover -s tests -v
.\.venv\Scripts\python.exe host\offline_check.py
.\Flash.cmd --check
```

- 单元测试覆盖配对材料的唯一性、复用和残缺/不匹配拒绝。
- `offline_check.py` 用模拟板端验证证书校验、TLS WebSocket、PCM 分帧与序号、发送/草稿/取消、旧协议兼容、虚拟麦克风缺失和回执丢失等路径。
- `Flash.cmd --check` 校验四个固件文件与发布清单一致，并检查 Windows 热点能力，不写开发板。

固件没有单元测试；需要验证时编译后用 `firmware` 文件夹的「串口监视」任务观察日志。

### 常改文件

| 文件 | 作用 |
| --- | --- |
| `windows/host/desktop.py` | 主窗口与程序入口 |
| `windows/host/setup_dialog.py` | 烧录配网对话框 |
| `windows/host/flash.py` | 识别设备、备份、写入、USB 配网、启动服务 |
| `windows/host/companion.py` | 发现设备、TLS WebSocket 音频服务、按语音目标路由结束动作 |
| `windows/host/voice_target.py` | 语音目标抽象与选择（Codex / DeepSeek Harness） |
| `windows/host/dictation.py`、`dictation.ps1` | 调用 Codex 桌面听写控件 |
| `windows/host/dsh_dictation.py`、`dsh_dictation.ps1` | 调用 DeepSeek Harness 语音输入控件（实验） |
| `windows/host/virtual_mic.py` | 把 PCM 写入 VB-CABLE 并做 16 kHz → 48 kHz 转换 |
| `windows/host/hotspot.py`、`hotspot.ps1` | Windows 2.4 GHz 移动热点 |
| `firmware/main/app_main.c` | 板端 UI 与主逻辑 |
| `firmware/main/air_mouse.c` | 陀螺仪鼠标算法；灵敏度、死区、方向在文件顶部 |
| `firmware/main/voice.c` | Wi-Fi 连接、TLS WebSocket、录音与协议 |
| `firmware/main/provision.c` | USB Serial/JTAG 配网命令 |

## 安全提醒

- `windows/.local` 中的 `server.key`、`server.crt`、`pairing.txt` 是这台电脑与这块开发板之间的信任材料，**不要提交、不要外传**。`.gitignore` 已覆盖该目录。
- 构建出的固件镜像内嵌同一套证书、私钥和配对令牌；`.local/backups` 中的原始 Flash 备份还包含板上的 Wi-Fi 配置与原有数据。二者都只在本机保存。
- 换电脑时不要复制旧的 `.local` 到新仓库位置并混用：请在新电脑重新生成，并同时重新构建、烧录固件与 Windows 程序，否则两侧配对材料不一致。
- 需要轮换密钥时，删除 `windows/.local` 中的 `server.crt`、`server.key`、`pairing.txt`，重新运行 `Setup-Dev.ps1`，然后重新编译固件与辅助程序并重新烧录。
- 语音诊断日志在 `windows/.local/companion.log`，烧录配网日志在 `windows/.local/setup.log`；日志不记录 Wi-Fi 密码，但仍建议在公开求助前检查内容。

## 迁移与验证状态

- **已验证**：`firmware/Build.ps1` 在 ESP-IDF 5.5.5 + ESP32-C6 下编译干净（0 error / 0 warning，应用约 2.3 MB，8 MB 应用分区占用约 28%）并生成 4 镜像与 `airremote-release.json`；实机烧录后 `AR1 READY 7`、显示/触摸/PMU/音频/IMU 正常；语音链路实测到 `UDP 发现 → TLS 1.2 → WebSocket → AUTH/READY2 → CAPTURE/GO → 麦克风 PCM 帧`；`windows/Flash.cmd --check` 通过；Windows 侧单元测试（14/14）与 `offline_check.py` 双目标协议检查通过；`Build-App.ps1` 可重新打包 EXE。
- **2026-11-09 修复（待实机复核）**：BLE HID 因缺少 `esp_ble_gatts_register_callback(esp_hidd_gatts_event_handler)` 而从不广播（Windows 搜不到设备）——已修复；同步加固 BLE release/resume 幂等、A/B 按键防卡键对账、鼠标失败复位；语音会话期间关闭 Wi-Fi modem sleep 以修复 `PULL` 往返延迟导致的 PCM 缓冲溢出；发现改为板端单播 `AR1A` + PC 端 47682 监听。
- **2026-11-09 新增语音目标切换（待实机复核）**：辅助程序内可切换 `codex` / `dsh`（热切换），DSH 侧复用 VB-CABLE 作为其麦克风、由 DSH 本机 SenseVoice 转写；Codex 路径保持原样，非法/缺失配置回退 Codex。设计与限制见 [docs/voice-targets.md](docs/voice-targets.md)。
- **仍待实测**：触摸方向、麦克风通道、亮度命令、无 PSRAM 内存余量、BLE 配对与鼠标/按键手感、语音完整 E2E；
  Codex 听写保持原流程实测，DSH 目标还需在 DSH 中准备 SenseVoice 模型、选择 CABLE Output 后验证（自动点击/手动回退两种路径）。
  逐项步骤、期望日志与 Windows 侧观察点见 [docs/pending-hardware-validation.md](docs/pending-hardware-validation.md)。
- ESP32-S3 → ESP32-C6 的改动、引脚表、镜像地址约定和未实机验证的风险点，见 [docs/firmware-c6-migration.md](docs/firmware-c6-migration.md)。
- [TEST_REPORT.md](TEST_REPORT.md) 是迁移前（ESP32-S3 时代）的本机验证记录，其中本地语音识别等章节对应已移除的功能，不代表当前 C6 版本的状态。

## 文档与许可

- [windows/README.md](windows/README.md)：Windows 辅助程序的运行、打包、烧录与协议。
- [firmware/README.md](firmware/README.md)：C6 固件的构建、分区、串口配网与语音链路。
- [docs/components.md](docs/components.md)：全局组件、项目组件与托管组件的完整清单。
- [docs/firmware-c6-migration.md](docs/firmware-c6-migration.md)：S3 → C6 迁移说明。
- [docs/pending-hardware-validation.md](docs/pending-hardware-validation.md)：接板验收的待实测清单（步骤、期望日志、Windows 侧观察点）。
- [docs/voice-targets.md](docs/voice-targets.md)：语音目标（Codex / DeepSeek Harness）架构、DSH 调研结论与限制。

本仓库自有源码采用 [Apache License 2.0](LICENSE)。第三方 SDK、组件和打包工具保留各自许可，见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。其中 esptool（GPL-2.0-or-later）会被打包进辅助程序；对外分发组合 EXE 时须遵守相应 GPL 要求。公开源码仓库不包含该 EXE 或设备密钥。

## 开发环境与官方来源

ESP-IDF、工具链、受管组件、Python 依赖等均可从官方获取，**不入库**；克隆后如何准备见
[`docs/development-environment.md`](docs/development-environment.md)（含 ESP-IDF v5.5.5、EIM、VS Code 扩展、
managed components、Python 3.12、VB-CABLE 等官方链接）。
