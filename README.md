# Codex Air Remote

适用微雪 ESP32‑S3‑Touch‑AMOLED‑1.8 电池款，16 MB Flash。固件使用官方 Waveshare BSP 2.0.3，在上电时探测触摸芯片并选择 V1 或 V2 对应的面板配置。

这是独立的社区源码项目，包含四图标触屏固件、蓝牙陀螺仪鼠标和 Windows 语音辅助程序。**当前已完成构建与模拟验证，尚未接开发板做实机验收。** 已知范围见 [TEST_REPORT.md](TEST_REPORT.md)。项目不隶属于 OpenAI、乐鑫或微雪。

## 从源码开始

需要 Windows 11、Python 3.12（64 位），以及用于固件的 ESP-IDF **5.5.5**。推荐用 VS Code 打开根目录的 `CodexAirRemote.code-workspace`。本仓库不包含已打包程序、模型、驱动、SDK 或本机配对材料。

1. 安装 Python 3.12，并在项目目录执行 `powershell -NoProfile -ExecutionPolicy Bypass -File .\Setup-Dev.ps1`。如果 Python 不在 PATH，可附加 `-Python "你的 Python 3.12 可执行文件路径"`。安装开发依赖需要下载，会消耗流量。
2. 用乐鑫官方安装器安装 ESP-IDF 5.5.5，并激活其开发环境。`Build.ps1` 可复用已激活的 `IDF_PATH`，也可通过 `-IdfActivate "激活脚本路径"` 或环境变量 `AIRREMOTE_IDF_ACTIVATE` 指定 PowerShell 激活脚本。当前维护者电脑的默认安装位置仍可自动识别。
3. 在 VS Code 执行「全部：编译固件并打包辅助程序」，或在 PowerShell 依次运行 `Build.ps1` 和 `Build-App.ps1`。首次编译需要下载依赖组件，会消耗流量。
4. 构建完成后再使用下文的图形烧录流程。

首次配置会在被 Git 忽略的 `.local` 中生成**独立的** TLS 证书、私钥和配对令牌，后续配置会保留它们。已存在但不完整或不匹配的材料会停止配置，不会自动覆盖。每份本机固件会嵌入对应密钥，不要把该固件、`.local`、配网数据或 Flash 备份上传到公共仓库。源码下载者应生成自己的材料并自行构建。

## 首次烧录

1. 用 USB-C 数据线接上开发板，打开 **app/CodexAirRemote.exe**，点击「烧录开发板」。
2. 选择语音配网方式。默认由电脑开启 **2.4 GHz 热点**，程序会自动配网。也可选择已有 **2.4 GHz Wi-Fi**，输入网络名称和 WPA2 密码。电脑用有线或 Wi-Fi 接入同一局域网即可。
3. 点击「开始烧录」。程序识别单个 Espressif USB 设备，备份原始 16 MB Flash，再写入并校验固件。随后通过 USB 写入配网信息，启动辅助服务并尝试配对蓝牙鼠标。
4. 如果 Windows 弹出配对提示，确认 **Codex Air Remote**。若未自动完成，点击辅助程序里的「蓝牙设置」并添加此设备。

首次备份可能需要几分钟。更换网络时，在同一个窗口选「只重新配网」即可保留现有固件。

## Windows 辅助程序

双击 **app/CodexAirRemote.exe**。板载录音通过 Windows 的 VB-CABLE 虚拟麦克风交给 Codex 桌面听写。

1. 从 [VB-Audio 官网](https://vb-audio.com/Cable/) 安装 VB-CABLE。
2. 在 Windows 声音设置中将 **CABLE Output** 设为默认输入设备。辅助程序会显示「虚拟麦克风已就绪」。辅助程序只把板端声音送到 **CABLE Input**。
3. 像平常一样打开 Codex，把目标对话保持在前台。辅助程序会按控件名称操作该对话的听写按钮。第一次用听写时，如有麦克风权限提示，请在 Codex 中处理。

程序的运行库位于 **app/_internal**，板卡配对数据位于 **.local**。在原目录打开 EXE。烧录成功后，Windows 登录时按界面保存的启停设置运行后台服务。

## 使用

屏幕上有 **Voice、Gyro、A、B** 四个触摸图标。

- **语音**。点 Voice，等板上显示 Recording 后对着开发板说话。点 A 请求 Codex 转录并发送，点 B 取消本次听写。A 在录音就绪后启用，B 在连接电脑时也可取消。录音满 60 秒而未点 A 时会取消。设备显示「Codex send requested」表示已触发桌面按钮，发送结果在 Codex 查看。
- **陀螺仪鼠标**。点 Gyro 开启，握住设备静止约一秒完成校准，再转动手腕移动光标。A 是鼠标左键，可轻点单击、连续轻点双击、按住拖拽并在松手时释放。B 是鼠标右键。再次点 Gyro 关闭。正常使用的操作都在触屏上完成。

两个模式互斥。鼠标通过蓝牙直接连接 Windows。语音通过加密的 Wi-Fi 连接把板载录音送到电脑，可用 Windows 热点或同一局域网。已有 Wi-Fi 需要允许设备互访。热点密码在本机生成，辅助服务会维持所选的热点。

## 用 VS Code 统一开发

在 VS Code 中选择「文件 → 从文件打开工作区」，打开根目录的 **CodexAirRemote.code-workspace**。固件和辅助程序在同一个窗口中编辑；直接打开项目根目录也会加载相同的运行和构建配置。

辅助程序使用 **Python 3.12 + Tkinter**，通过 **PyInstaller** 打包为 Windows EXE。工作区已指定项目的 `.venv`；运行首次配置后即可使用。推荐安装的 Python、Python Debugger 和 C/C++ 扩展已列入工作区配置：前两者负责运行与断点调试，后者读取现有固件的编译信息以提供源码导航。安装扩展需要下载，会消耗流量。

| 操作 | VS Code 入口 | 结果 |
| --- | --- | --- |
| 运行和调试辅助界面 | 「运行和调试」选择「辅助程序：界面（源码）」，按 F5；Ctrl+F5 不启用断点 | 直接运行 `host/desktop.py`，修改后重新启动即可看到变化 |
| 调试后台服务 | 选择「辅助程序：后台服务（源码）」，按 F5 | 在 `host/companion.py` 中设置断点；需要已完成配网并开启服务设置 |
| 打包辅助程序 | Ctrl+Shift+B | 更新 `app/CodexAirRemote.exe` 及 `app/_internal` |
| 编译固件 | 「终端 → 运行任务 → 固件：编译」 | 更新 `firmware/build` 中的镜像和校验清单 |
| 同时构建两者 | 「终端 → 运行任务 → 全部：编译固件并打包辅助程序」 | 依次编译固件、打包 EXE |
| 检查语音协议 | 「终端 → 运行任务 → 辅助程序：离线协议检查（模拟设备）」 | 用模拟设备检查音频传输和结束操作 |

开发前先在正在运行的辅助程序中停止后台服务，等待停止后关闭旧窗口。修改代码后重新运行。源码界面启动的服务也使用源码，打包后的 EXE 则使用包内代码；已有后台服务不会自动切换到新代码。打包前关闭现有 EXE 并停止服务，以免 Windows 占用文件。

固件的编译任务调用已配置的 ESP-IDF 5.5.5 环境；工作区不要求另装 ESP-IDF 扩展。两种构建任务调用 Windows 自带的 `powershell.exe`，不依赖 Codex 私有目录。更换电脑后按「从源码开始」配置 Python 和 ESP-IDF 即可。

常改文件：`host/desktop.py` 是主窗口，`host/setup_dialog.py` 是烧录配网窗口，`host/companion.py` 是设备语音服务；`firmware/main/app_main.c` 是板端主程序与界面。

重建辅助程序开发环境时运行 `Setup-Dev.ps1`，它创建 `.venv`、安装 `host/requirements-dev.txt` 并生成本机配对材料。此步骤需要下载依赖，会消耗流量。已有完整环境可用 `-SkipDependencyInstall` 仅检查配对材料。日常修改和打包直接复用本机已配置的环境。打包结果应保留原目录结构，`app/_internal` 不可丢弃。

## 诊断与构建

- `Flash.cmd --check` 校验四个固件文件和 Windows 热点能力。
- 只重新写入 Wi‑Fi 配置可执行 `Flash.cmd --provision-only`。也可双击 **Companion.cmd** 打开辅助程序界面。
- 只有 USB 供电而没有出现 Espressif 串口时，换数据线，或按住 BOOT 后短按 RESET，再松开 BOOT。烧录时只接这一块 Espressif 板。
- 首次烧录的原始镜像及校验文件位于 `.local/backups`。它保留原有固件和板上数据，和该设备的 MAC 对应。
- `firmware/main/air_mouse.c` 顶部集中放置灵敏度、死区和 X/Y 方向。修改后从 PowerShell 7 运行 `Build.ps1` 重新编译并生成烧录校验清单。
- 修改辅助程序后，从 PowerShell 7 运行 `Build-App.ps1` 可重新打包 Windows 应用。
- 本机生成的固件包含这台电脑与板卡配对用的材料，作为本地镜像保管。语音诊断日志位于 `.local/companion.log`。

实测范围见 [TEST_REPORT.md](TEST_REPORT.md)。

## 开源许可

本仓库自有源码采用 [Apache License 2.0](LICENSE)。第三方 SDK、组件和打包工具保留各自许可，见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。其中打包辅助程序所含 esptool 为 GPL-2.0-or-later，对外分发组合 EXE 时须遵守对应 GPL 要求；公开源码仓库不包含该 EXE 或设备密钥。
