# Codex Air Remote 本机验证记录

> **历史记录（ESP32-S3 时代；该 S3 工程已移出仓库，仅本机 archive_local/ 归档）**：本文件记录的是 2026‑11‑06 迁移到
> ESP32-C6-Touch-AMOLED-2.16 之前的验证结果。其中“本地语音识别 / Fun-ASR /
> faster-whisper / CUDA”等章节对应已经移除的早期功能，不代表当前 C6 版本的
> 状态。当前版本缺少开发板实机验收，见 [docs/firmware-c6-migration.md](docs/firmware-c6-migration.md)。

2026‑11‑06，Windows 11。开发板按用户安排留到交付后连接和烧录。

| 项目 | 结果 |
|---|---|
| ESP-IDF v5.5.5，ESP32-S3 目标 | 构建成功。应用镜像 0x1C6150 字节，占 8 MiB 应用分区约 22%。 |
| 固件文件 | Bootloader、分区表、OTA 初始数据、应用四个文件的 SHA‑256 与烧录清单相符。 |
| 烧录入口 | 实际运行 Flash.cmd 的校验模式成功。正常模式在无匹配 USB 设备时返回错误并停止。 |
| Windows 2.4 GHz 移动热点 | 成功启动，主机可以绑定热点侧 IPv4，随后成功关闭，恢复到测试前的关闭状态。 |
| Windows 蓝牙 | 按设备地址查找的 WinRT 入口在本机可调用。用无设备地址验证了无匹配返回路径。 |
| 本地语音识别 | 16 kHz 单声道测试样本识别通过。英文样本含 “sends a message”，中文样本转录为“這是一次本地語音識別測試。”。静音输入返回空文本。 |
| Windows 语音接收 | 用本机模拟板端验证了证书校验、TLS WebSocket、PCM 分帧与序号、结束及 ACK。 |
| Codex 接入 | 使用已登录的桌面版 Codex 所带 App Server，通过本机协议握手和账户读取验证。语音真正发送到专用对话待实机首轮。 |

## Windows 图形程序

- 双击打包后的 CodexAirRemote.exe，检查了中文界面、首次烧录提示、识别设备选项和操作按钮。
- 使用打包后的 EXE 分别在 CPU 和 RTX 5060 Ti（CUDA）转录中文样本，并验证了已登录的 Codex 账户。
- 使用独立的测试配网数据启动后台服务，验证了 CPU 待机、切换至 CUDA 和正常停止。
- 板端录音与 Windows 辅助程序的实机联调仍待接板。

## 电子行业中英文转录

使用当前的多语言 faster-whisper-base 和应用内识别设置，测试 14 条合成录音，其中 12 条在中文句子中插入英语术语，另 2 条验证中文单位。录音由 Windows 中英文语音合成器生成。测试直接读取 PCM，板载麦克风、人声口音和车间背景噪音留待接板验证。

145.16 秒音频在本机 CPU 上耗时 17.76 秒，RTX 5060 Ti 上耗时 4.60 秒。耗时包含静音检测和转录，计时从模型加载后开始，不含录音和 Wi-Fi 传输。

| 预期字段 | CPU 结果 | CUDA 结果 |
|---|---|---|
| CAN FD，500 kbps | Can FD，500 KBPS | Can FD，500 KBPS |
| STM32F103，SWD | STM32F103，SWD | STM32F103，SWD |
| STM32F103C8T6 / STM32F103CBT6 | STM32F103CAT6 / STM32F103CBT6 | STM32F103CAT6 / STM32F103CBT6 |
| 参考电压 3.3 伏 | 參考電壓是 3.3 幅 | 參考電壓是 3.3 幅 |
| VGS 为负 0.3 伏 | VGS 是負 0.3 幅 | VGS 是附 0.3 幅 |
| I²C 地址 0x3C 改为 0x3D | 保留两个地址，以空格隔开字符 | 保留两个地址，以空格隔开字符 |
| 0.25 毫安，25 微秒 | 两项数值和单位均保留 | 两项数值和单位均保留 |

完整料号、正负号和单位在这些样本中出现了会改变工程含义的错误。配置要求已在重新打包的 EXE 中打开核对，该 EXE 也通过了 STM32F103 与 SWD 的转录测试。

## Fun-ASR-Nano-2512

- 从 hf-mirror.com 下载 sherpa-onnx INT8 版，按固定版本校验六个文件，总计 1,009,605,061 字节。中文界面可以选用已安装的模型。
- 重新打包的 Windows EXE 分别通过 Fun-ASR-Nano-2512 和 Whisper Base 的中文转录测试。Fun-ASR 在本版本使用 CPU。
- 使用同一组 14 条合成录音，Fun-ASR 正确转写了 3.3 伏、负 0.3 伏以及 0.25 毫安、25 微秒。完整料号 STM32F103C8T6 仍被转成 STM 32 F 103 CAT 6。含英语缩写的输出可能按发音拆开或出现错词。
- 对 60 秒的合成录音按停顿分段转录，打包程序识别到了音频开头和结尾的校验语句。实际板载麦克风与录音环境待接板验证。

## Codex 桌面听写迁移

- 已移除辅助程序里的本地模型选择、下载和 CPU/CUDA 设置。已清理该工程的 Whisper Base 和 Fun-ASR-Nano-2512 权重及 Base 测试副本。
- 使用本机 Codex App Server 的实验性实时接口测试时，现有桌面账号被要求提供 API Key。测试停在会话启动阶段，未上传录音。新版界面提供「打开 Codex」，从输入框的麦克风听写。
- 模拟板端验证了加密音频传输和转接不可用时的状态确认。

## 板载麦克风与 Codex 听写

- 模拟板端通过加密 WebSocket 验证音频交付、发送、保留草稿、取消、旧协议兼容，以及虚拟麦克风缺失时终止会话。模拟发送回执丢失时不重发。
- Windows 辅助程序检测到本机尚未安装 VB-CABLE。桌面听写按钮与虚拟音频的实机联动待接入驱动和开发板验证。

## 四图标触屏控制

- 新版固件构建成功，四个烧录镜像通过 SHA-256 校验。
- 用 Windows 测试程序运行固件的触摸分发和按键事件逻辑。语音 A 发送、B 取消、只接受第一次结束操作，鼠标模式双击的两次左键按下与释放、按住释放、右键和队列溢出停机均通过。
- 辅助程序的模拟板端音频传输及发送、取消回归通过。触屏与蓝牙的实机联动待烧录验证。

## 图形烧录与配网

- 已把 USB 烧录、Windows 热点和现有 Wi-Fi 配网集成到 Windows 辅助程序。模拟验证了无设备退出、备份先于写入、仅配网流程，以及配网失败后关闭本次启动的热点。密码字段遮罩，并验证日志不记录配网密码。
- 已通过打包后的 EXE 运行内置 esptool，成功读取 ESP32-S3 固件镜像。图形界面的两个旧按钮已移除。实际 USB 写入、Wi-Fi 连通和蓝牙配对仍待接板。

## VS Code 统一开发入口

- 新增 `CodexAirRemote.code-workspace` 及 `.vscode` 运行、调试、任务和编辑配置；本机已安装 Python、Python Debugger、C/C++ 扩展。JSON、解释器、源码路径、任务依赖与构建命令路径检查通过。
- 从源码启动服务时，即使已有打包 EXE，也使用当前源码；模拟启动验证了源码和打包程序各自的启动命令。辅助程序语法检查和离线加密音频协议回归通过。
- 按 `.vscode/tasks.json` 中的实际命令依次执行固件编译和 EXE 打包，均成功。日志为 `.tools/vscode-firmware-build.log` 和 `.tools/vscode-app-build.log`。四个烧录镜像的 SHA-256 校验通过，新 EXE 的内置 esptool 成功读取 ESP32-S3 镜像。
- 本轮未操作 VS Code 图形界面的 F5 调试，也未连接开发板；上述构建与回归通过命令执行。

## 公开源码准备

- 新增首次开发环境配置与本机配对材料初始化。验证了独立安装的令牌和私钥不同、重复运行保留文件与时间戳、残缺文件不被覆盖、证书与密钥不匹配时拒绝继续。
- 现有本机配对材料通过检查并保留。使用 Windows 自带 PowerShell 按更新后的 VS Code 任务完成固件构建与 EXE 打包，四个镜像校验通过，打包 EXE 的 esptool 镜像检查通过，许可文本随包包含。
- 离线加密音频协议回归通过。私钥、令牌、网络配置、SDK 缓存、虚拟环境、构建结果与原始 Flash 备份均排除在 Git 之外。公开源码不包含预编译固件或 Windows 应用。
- 配置证书测试为自动化软件检查；硬件、驱动与 Codex 听写的完整实机验收仍未完成。

## 待实机验证

- USB 备份、擦写、校验及板上配网确认。
- 实物版本识别、AMOLED、触屏、AXP2101 电量。
- Windows BLE 配对和重连，触屏 A 左键单击、双击、拖拽与 B 右键。
- 竖握、倾斜和横握的手腕映射、静止漂移及灵敏度。
- 板载 ES8311 采集、实际热点音频、Codex 专用对话发送、长时间运行。

## 对应资料

- [微雪官方工程和示例](https://github.com/waveshareteam/ESP32-S3-Touch-AMOLED-1.8)
- [Waveshare BSP 2.0.3](https://components.espressif.com/components/waveshare/esp32_s3_touch_amoled_1_8/versions/2.0.3/readme)
- [ESP-IDF v5.5.5](https://github.com/espressif/esp-idf/releases/tag/v5.5.5)
- [Windows 会话级热点配置](https://learn.microsoft.com/uwp/api/windows.networking.networkoperators.networkoperatortetheringsessionaccesspointconfiguration)
- [Codex App Server](https://learn.chatgpt.com/docs/app-server)
- [多语言 faster-whisper-base 模型](https://huggingface.co/Systran/faster-whisper-base)
