# Windows 辅助程序（legacy / 已退役）

> **⚠️ Legacy（已退役）**：本目录是旧的 **Codex 语音 / VB-CABLE / UIA** 辅助程序，不再作为交付路径维护。
> 新主路径是 DSH 插件 [`plugins/dsh-airremote`](../plugins/dsh-airremote/README.md)：开发板语音直连 DSH、本地 whisper 转写写草稿，不经 VB-CABLE；设计见 [`docs/plugin-dsh-airremote.md`](../docs/plugin-dsh-airremote.md)。

`windows/` 是 Codex Air Remote 的 Windows 侧程序，使用 **Python 3.12 + Tkinter**，由 **PyInstaller** 打包为 onedir 形式的 EXE。它负责把开发板接进 Codex：烧录固件、写入 Wi-Fi 配置、维持与板端的加密音频连接、把板载录音送到 VB-CABLE 虚拟麦克风，并按控件名称触发 Codex 桌面听写。板端固件的说明见 [../firmware/README.md](../firmware/README.md)，整体架构见 [../README.md](../README.md)。

## 功能

| 功能 | 说明 |
| --- | --- |
| 图形界面 | 显示服务状态、设备网络方式、最近一次语音结果；启动/停止后台服务 |
| 烧录开发板 | 识别唯一的 Espressif USB 设备，备份原始 Flash，按固定地址写入并校验 |
| Wi-Fi 配网 | 通过 USB Serial/JTAG 把 SSID/密码写进板端 NVS；可选电脑热点或已有 2.4 GHz Wi-Fi |
| 音频服务 | UDP 发现 + TLS WebSocket 接收板端 PCM，检查虚拟声卡后写入 CABLE Input |
| 听写控制 | 用 Windows UI Automation 操作 Codex 桌面听写按钮（开始/发送/停止/取消） |
| Windows 热点 | 用 WinRT 移动热点开 2.4 GHz 网络，SSID/密码由配对令牌派生 |
| 蓝牙配对 | 烧录配网完成后按板端蓝牙地址调用 WinRT 配对 |
| 本机配对材料 | 首次配置生成 TLS 证书、私钥和 64 位 hex 配对令牌，供固件构建内嵌 |

## 目录

| 路径 | 内容 |
| --- | --- |
| `host/desktop.py` | 主窗口、程序入口；`--service`、`--test-report`、`--esptool-worker` 也在这里分发 |
| `host/setup_dialog.py` | 「烧录开发板与配网」对话框 |
| `host/flash.py` | 设备识别、备份、写入校验、USB 配网、启动服务、蓝牙配对 |
| `host/companion.py` | 后台服务：发现设备、TLS WebSocket、音频路由、结束动作 |
| `host/codex_adapter.py` | Codex app-server 客户端（账号/线程接口）；当前用于自检与账号读取 |
| `host/dictation.py`、`host/dictation.ps1` | 调用 Codex 桌面听写控件 |
| `host/virtual_mic.py` | VB-CABLE 播放端点；16 kHz → 48 kHz 转换与默认输入检查 |
| `host/hotspot.py`、`host/hotspot.ps1` | Windows 移动热点 |
| `host/pair-mouse.ps1` | 按蓝牙地址配对 HID 设备 |
| `host/app_runtime.py` | 路径、偏好、单实例互斥体、服务启动与状态文件 |
| `host/offline_check.py` | 用模拟设备跑加密音频协议回归 |
| `host/requirements.txt`、`requirements-dev.txt` | 运行时/开发依赖 |
| `tools/init_pairing.py` | 生成或校验本机配对材料 |
| `tests/test_init_pairing.py` | 配对材料初始化的 `unittest` |
| `.vscode/` | 本文件夹的任务、调试与解释器配置 |
| `.venv/` | 项目内 Python 3.12 环境（忽略，不提交） |
| `.local/` | 本机配对材料、配置、备份与日志（忽略，不提交） |
| `app/` | 打包输出：`CodexAirRemote.exe` + `_internal`（忽略，不提交） |
| `build/` | PyInstaller 中间产物（忽略，不提交） |
| `vendor/codex-app-server-schema/` | Codex app-server 协议 schema 参考 |
| `Setup-Dev.ps1` | 首次环境配置 |
| `Build-App.ps1` | 打包 EXE |
| `Companion.cmd` | 双击打开 `app/CodexAirRemote.exe` |
| `Flash.cmd` | 命令行烧录/配网入口 |

## 依赖

### 系统组件（不随仓库提供）

- Windows 11 x64。
- Python **3.12 x64**。3.13 移除了 `audioop`，`virtual_mic.py` 的采样率转换无法工作。
- 支持 2.4 GHz 移动热点的无线网卡，且电脑有可共享的上网连接（仅热点模式需要）。
- [VB-CABLE](https://vb-audio.com/Cable/) 虚拟声卡，安装后把 **CABLE Output** 设为默认输入设备。
- 已安装并登录的 Codex 桌面版。听写脚本按 Appx 包 `OpenAI.Codex` 定位 `ChatGPT.exe`，并要求目标对话在前台。

### 项目依赖（自动安装）

| 包 | 版本 | 用途 |
| --- | --- | --- |
| `websockets` | 15.0.1 | TLS WebSocket 客户端 |
| `pyserial` | 3.5 | USB 串口配网、端口枚举 |
| `esptool` | 5.2.0 | 读取 Flash、写入镜像；被打包进 EXE |
| `pyinstaller` | 6.22.0 | 打包（仅开发依赖） |
| `cryptography` | 50.0.2 | 生成 RSA 证书与密钥（仅开发依赖） |

## 初始化

```powershell
cd windows
powershell -ExecutionPolicy Bypass -File .\Setup-Dev.ps1
```

`Setup-Dev.ps1` 依次执行：

1. 校验指定 Python 是 3.12（不满足时可用 `-Python "C:\Path\python.exe"`）；
2. 创建 `windows/.venv`（已存在则校验版本）；
3. 安装 `host/requirements-dev.txt`（加 `-SkipDependencyInstall` 可跳过）；
4. 运行 `tools/init_pairing.py`，在 `windows/.local` 生成配对材料。

配对材料只在缺失时创建；只要有一个文件存在，就要求三个文件齐全且证书与私钥匹配，否则报错并保留现有文件。

### `windows/.local` 的内容

| 文件 | 说明 |
| --- | --- |
| `server.crt` | 板端 TLS 服务证书（CN/SAN `airremote.local`，RSA 2048，有效 10 年）；Windows 侧用它校验板端 |
| `server.key` | 对应私钥，编译时嵌入固件 |
| `pairing.txt` | 64 位小写 hex 配对令牌（32 字节），固件与辅助程序共享 |
| `network.json` | 配网方式：`hotspot` 或 `lan` |
| `companion-settings.json` | 后台服务启停偏好（`enabled`） |
| `companion-state.json` | 服务状态与最近一次语音结果 |
| `codex-thread.json` | app-server 线程 id（文本提交路径使用；当前语音链路不经过它） |
| `backups/` | 首次烧录前的 16 MB 原始 Flash 备份及 `.sha256` |
| `companion.log` | 后台服务日志（512 KB 轮转，保留 2 份） |
| `setup.log` | 烧录/配网历史日志 |
| `flash.lock` | 防止同时运行两个烧录/配网任务 |

## 运行与调试

```powershell
# 打开打包后的程序
.\Companion.cmd

# 直接用源码运行界面
.\.venv\Scripts\python.exe host\desktop.py

# 直接运行后台服务（需要已完成配网）
.\.venv\Scripts\python.exe host\companion.py
```

VS Code 选择 `windows` 根后可用：

- 调试配置「辅助程序：界面（源码）」→ `host/desktop.py`
- 调试配置「辅助程序：后台服务（源码）」→ `host/companion.py`
- 任务「辅助程序：打包 EXE」「辅助程序：准备开发环境」「辅助程序：运行源码界面」「辅助程序：离线协议检查（模拟设备）」「辅助程序：单元测试」「辅助程序：烧录/配网」

后台服务的行为：

- 用命名互斥体 `Local\CodexAirRemoteCompanion` 保证单实例；重复启动直接退出。
- 启动条件：`network.json` 已配网且偏好为启用。
- 若 `network.json` 为 `hotspot`，服务每 15 秒确保 Windows 热点处于开启状态。
- 源码运行时通过 `pythonw host/companion.py` 启动；打包后通过 `CodexAirRemote.exe --service` 启动。
- 烧录配网成功后会在当前用户的「启动」文件夹创建 `Codex Air Remote.lnk`，Windows 登录时自动运行 `--service`。

修改代码前先在界面里「停止服务」并关闭旧窗口；源码界面启动的服务使用源码，打包 EXE 使用包内代码，两者不会自动切换。

## 语音目标（Codex / DSH）

板端 Voice 录音可以接到两个目标之一，在「烧录开发板」窗口的「语音目标」里切换：

| 目标 | 音频去向 | 识别由谁完成 | 结束语义 |
| --- | --- | --- | --- |
| `codex`（默认） | VB-CABLE → Codex 桌面听写 | Codex 桌面 | A 发送、B 取消，行为与旧版一致 |
| `dsh`（实验） | VB-CABLE → DeepSeek Harness 语音输入 | DSH 本机 SenseVoice（ONNX） | 停止后文字进 DSH 草稿，**不自动发送** |

- 选择写入 `windows\.local\companion-settings.json` 的 `voice_target`（`codex` / `dsh`），旧设置文件
  可直接兼容；缺失或非法值一律按 `codex` 处理。
- **热切换**：companion 在每次语音会话开始时重新读取设置，下一次 Voice 会话即生效，无需重启服务。
- Codex 目标仍要求把目标 Codex 对话放在前台。

### 首次使用 DSH 目标

1. 打开 DeepSeek Harness（桌面版，`desktop` profile 已内置语音输入实验插件）。
2. DSH → 插件 → 语音输入 → 准备模型（SenseVoiceSmall，本机 CPU；首次需下载，之后完全本地）。
3. 在同一插件详情里把「输入设备」选为 **CABLE Output（VB-Audio Virtual Cable）**（只需一次，DSH 会记住）。
4. 辅助程序里把「语音目标」切到 DeepSeek Harness；之后点开发板 Voice，DSH 会从 CABLE 收到板载音频。

### 限制

- DSH 语音输入是实验特性（插件 0.2.2-rc.1），DSH 升级后按钮文案/结构可能变化，需要复测。
- 自动点击 DSH 的麦克风/停止按钮依赖 Chromium 无障碍：UIA 查询会按需激活无障碍树（本机实测可见 189 个按钮），
  但**模型未准备**时语音按钮是「打开语音输入引导」，辅助程序会返回 `DSH_SETUP_REQUIRED` 提示先准备模型；
  准备后若仍不可自动化，则进入**手动模式**：音频照常送入 CABLE，请在 DSH 里手动点「开始录音」，
  说完点「停止并识别」，文字进入草稿后自行发送。若想排查自动点击，可用
  `DeepSeek Harness.exe --force-renderer-accessibility` 启动 DSH 后复测。
- DSH 只把识别结果写进草稿，不会自动发送；板端 A/B 在手动模式下不会点击 DSH。
- 详细设计与调研见 [../docs/voice-targets.md](../docs/voice-targets.md)。

## 打包

```powershell
cd windows
powershell -ExecutionPolicy Bypass -File .\Build-App.ps1
```

- 入口 `host/desktop.py`，输出 `windows/app/CodexAirRemote.exe` 与 `windows/app/_internal`。
- `host/hotspot.ps1`、`host/dictation.ps1`、`host/dsh_dictation.ps1`、`host/pair-mouse.ps1` 以数据文件形式打进包内。
- 根目录的 `LICENSE`、`NOTICE`、`THIRD_PARTY_NOTICES.md` 和 `LICENSES/GPL-3.0.txt` 会放到包内 `licenses`。
- 中间产物在 `windows/build/pyinstaller`；旧的 `app` 会先移到 `build/pyinstaller/previous-*` 再替换，失败时自动回滚。
- 打包前关闭正在运行的 EXE 并停止服务，否则 Windows 会占用 `app/_internal` 中的文件。

`app/_internal` 不能单独删除或移动，分发时必须保留整个 `app` 目录。

## 测试

```powershell
cd windows
.\.venv\Scripts\python.exe -m unittest discover -s tests -v
.\.venv\Scripts\python.exe host\offline_check.py
.\.venv\Scripts\python.exe host\companion.py --check-codex
.\Flash.cmd --check
```

- `tests/`：配对材料唯一/可复用/证书私钥匹配；`test_voice_target.py` 覆盖语音目标设置持久化、
  默认/非法值回退 Codex、Codex/DSH 目标选择、DSH 手动回退与模型未准备异常。
- `offline_check.py`：用模拟板端校验证书链、TLS WebSocket、帧序号、Codex 目标的发送/草稿/取消/旧协议、
  DSH 目标的草稿/取消/手动模式/未准备模型、虚拟声卡缺失、回执丢失等路径，不需要开发板或应用安装。
- `--check-codex`：调用已登录 Codex 的 app-server，读取账号状态，不发送提示词。
- `.\Flash.cmd --check`：校验四个固件文件与 `airremote-release.json` 的 SHA-256 一致，并检查 Windows 热点能力，不写开发板。

## 烧录与配网

### 命令行

```powershell
.\Flash.cmd                          # 烧录 + 配网（默认电脑热点）
.\Flash.cmd --check                  # 只校验镜像与热点能力
.\Flash.cmd --provision-only         # 只重新写 Wi-Fi 配置
.\Flash.cmd --port COM5              # 指定端口（默认自动识别唯一的 303A:1001）
.\Flash.cmd --wifi-ssid MyWiFi       # 使用已有 2.4 GHz Wi-Fi，运行时会提示输入密码
```

`Flash.cmd` 会切换到 `windows` 目录、设置 UTF-8 代码页，结束后暂停显示结果。

### 图形界面

`Companion.cmd` 或 `app\CodexAirRemote.exe` → 「烧录开发板」：

1. 用 USB-C 数据线连接开发板，只连接要操作的一块。
2. 选择「电脑开启 2.4 GHz 热点（自动配置）」或「连接已有的 2.4 GHz Wi-Fi」并填写 SSID/密码。
3. 点「开始烧录」或「只重新配网」。

对话框会显示进度、禁用重复操作；「烧录日志」打开 `windows/.local/setup.log`。

### 烧录流程

1. 枚举 `VID:PID = 303A:1001` 的串口，必须恰好一个；否则停止。
2. 读取 `firmware/build/airremote-release.json`，逐个核对四个镜像的 SHA-256，不一致立即停止。
3. 用 `esptool --chip esp32c6 flash-id` 确认 Flash 为 16 MB 并读取 MAC。
4. 备份完整 16 MB Flash 到 `.local/backups/<mac>-before-air-remote.bin`，写同名 `.sha256`；已存在则校验大小与摘要后复用。
5. 备份后重新读取 MAC，确认设备未变化。
6. 按固定地址写入并校验：bootloader `0x0`、分区表 `0x8000`、otadata `0x10d000`、应用 `0x200000`。
7. 以 115200 波特率通过 USB Serial/JTAG 发送 `AR1?`，收到 `AR1 READY <flags> <12 位蓝牙 MAC>` 后发送 `AR1W <ssid hex> <password hex>`，等待 `AR1 WIFI OK`。
8. 写入 `network.json`，创建登录启动快捷方式，启动后台服务。
9. 用板端返回的蓝牙 MAC 调用 `pair-mouse.ps1` 配对；失败不阻塞整体流程。

各步骤的原始输出写入 `setup.log`；`--check` 会校验上述镜像清单，但不会访问串口。

## 协议与配对材料

板端作为 TLS 服务端运行，Windows 作为客户端连接。整个过程只在局域网内进行：

| 项目 | 值 |
| --- | --- |
| 发现 | UDP `47682`，双向：Windows 绑定 `0.0.0.0:47682` 并广播 `AR1?` + 16 字节随机数；板端在等待客户端期间每约 500 ms 向网关单播 `AR1A` + 6 字节 STA MAC（Windows 移动热点不转发主机广播），同时保留广播应答 `AR1!` + 同一随机数作为普通 AP 环境的后备。Windows 收到任一即连接 |
| 音频通道 | WSS `wss://<板端 IP>:47683/voice`，SNI `airremote.local`，TLS 固定 1.2（板端只开 TLS 1.2，客户端不锁定会因默认 TLS 1.3 ClientHello 被拒） |
| 认证 | 首帧文本 `AUTH <64 位 hex 配对令牌>`；板端回 `READY2`（旧固件为 `READY`） |
| 录音启动 | `CAPTURE` → `GO`（仅 `READY2`；旧协议直接拉流） |
| 拉流 | Windows 发 `PULL`，板端回二进制帧：4 字节大端序号 + 640 字节的整数倍单声道 PCM（1–2 帧/次），或 `WAIT` |
| 结束 | 板端在 `PULL` 响应中发 `SEND`、`DRAFT` 或 `CANCEL` |
| 回执 | Windows 发 `SUBMITTED`、`DRAFTED`、`CANCELLED`、`SAVED`、`EMPTY`、`FAILED` 或 `ABORT`，板端回 `ACK` |
| 音频格式 | 16 kHz、单声道、16 bit PCM，640 字节 = 20 ms；单次录音上限 60 秒 |

Windows 侧会校验序号连续、帧长在 644–3204 字节之间且 `(长度 - 4) % 640 == 0`，超长录音直接判错。

### 配对材料如何配合

- 板端固件内嵌 `server.crt`、`server.key` 和 `pairing.txt`，用证书启动 WSS 服务，用恒定时间比较校验令牌。
- 辅助程序用 `server.crt` 作为 CA 校验板端证书，并发送同一令牌认证自己。
- 热点 SSID 为 `AirRemote-` + `sha256(pairing)[:6]` 的大写 hex；密码为 `HMAC-SHA256(pairing, "Air Remote Wi-Fi")` 的前 24 位 hex，因此无需在界面展示或保存热点密码。

## 常见问题

| 现象 | 处理 |
| --- | --- |
| `Setup-Dev.ps1` 报 Python 3.12 is required | 用 `-Python` 指向 3.12 x64 的 `python.exe`；不要用 3.13 |
| `Build-App.ps1` 报 Run windows\Setup-Dev.ps1 first | 先完成初始化；`.venv` 在项目内，不随仓库提供 |
| 打包失败或 EXE 行为异常 | 关闭正在运行的 `CodexAirRemote.exe`、停止后台服务后重试；保留整个 `app` 目录 |
| 提示未找到 Espressif USB 设备 | 换支持数据传输的 USB-C 线；确认只插了这块板；必要时按住 BOOT 后短按 RESET 再松开 |
| 提示检测到多个 Espressif 设备 | 只连接要烧录的一块，或用 `--port COMx` 指定 |
| 热点模式报已有 Windows 热点在运行 | 首次使用前先关闭系统里现有的移动热点；配网成功后服务会接管维持 |
| 热点启动失败 | 确认无线网卡支持 2.4 GHz 移动热点、电脑有可共享的上网连接，并查看 `companion.log` |
| 固件已写入但配网失败 | 保留 USB 连接，重新运行「只重新配网」；不要重复擦写 |
| 蓝牙配对失败 / 搜不到 Codex Air Remote | 板端串口应出现 `BLE HID started` 与 `BLE advertising started`；缺失说明固件 BLE 广播未启动（GATTS 回调未注册或广播配置失败）。板子在语音会话期间会释放 BLE，此时搜不到属正常 |
| 光标不动或卡键 | 板端先确认 `BLE host connected`、屏幕显示 `Mouse active`；Windows 侧可用 `firmware/build/mouse_probe.py` 观察光标与按键 |
| 界面提示没有检测到 VB-CABLE | 安装 VB-CABLE 后重启音频服务；CABLE Output 必须存在且为默认输入 |
| 提示请将 CABLE Output 设为默认麦克风 | 在 Windows 声音设置中修改默认输入设备，然后重试 |
| 听写未就绪 / 找不到按钮 | 把目标 Codex 对话放到前台并确保只有一个「听写」按钮；Codex 需已登录 |
| 显示「操作结果未确认」 | 发送回执丢失时不重发，避免重复提交；请到 Codex 中确认结果 |
| 原始备份大小异常 / 校验不一致 | 立即停止，不要格式化或擦除开发板；保留 `.local/backups` 以便恢复 |

## 安全

- `windows/.local` 含私钥、配对令牌、Wi-Fi 配置、原始 Flash 备份和日志，已列入 `.gitignore`；不要提交或发给他人。
- 打包进 EXE 的 `esptool` 为 GPL-2.0-or-later；对外分发组合 EXE 时按 GPL 要求随附许可证与对应源码。详见根目录 [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)。
- 辅助程序不包含 Codex 程序、模型或账号凭据，也不绕过 Codex 的界面权限；它只操作已登录桌面应用暴露的听写控件。

## 开发环境与官方来源

Python 3.12、VB-CABLE、Codex 桌面版等 Windows 侧依赖的官方下载链接见
[`../docs/development-environment.md`](../docs/development-environment.md)。
