# 项目总结与换电脑继续开发指南

> 面向「换一台电脑继续开发」场景：先读第 1 节了解项目现状，再按第 2 节迁移环境与代码，
> 第 3 节是新电脑首次跑通流程，第 4 节是 Git 工作流。
> 环境版本与官方下载链接见 [`development-environment.md`](development-environment.md)；
> 实机验证清单见 [`pending-hardware-validation.md`](pending-hardware-validation.md)。

## 1. 项目总结

### 1.1 这是什么

**Codex Air Remote**：把微雪 **ESP32-C6-Touch-AMOLED-2.16** 开发板变成 Codex 的无线输入设备。

- **Windows 辅助程序**（`windows/`，Python 3.12 + Tkinter）：USB 烧录与 Wi-Fi 配网、TLS/WSS 语音桥、
  VB-CABLE 虚拟麦克风路由、语音目标切换（Codex 桌面听写 / DeepSeek Harness）、2.4 GHz 热点管理、蓝牙鼠标配对。
- **ESP32-C6 固件**（`firmware/`，ESP-IDF 5.5.5）：480×480 LVGL 触屏界面、BLE HID 空中鼠标（QMI8658）、
  按钮 A/B（鼠标左右键 / 语音发送取消）、Wi-Fi + TLS1.2 + WebSocket 语音链路、USB Serial/JTAG 配网命令。
- 迁移前的 S3 归档工程**已移出仓库**（本机 `archive_local/firmware_s3/`，不参与构建）。

### 1.2 硬件

| 项目 | 规格 |
| --- | --- |
| 板卡 | Waveshare ESP32-C6-Touch-AMOLED-2.16（电池款） |
| MCU | ESP32-C6，单核 RISC-V 160 MHz，512 KB SRAM，无 PSRAM |
| Flash | 16 MB（固定分区表，factory 应用 8 MB） |
| 显示 | 480×480 AMOLED，SH8601，QSPI（CS=GPIO15、CLK=GPIO0、D0..D3=GPIO1..4，引脚 A/B 变体见第 3.7 节） |
| 触摸 | CST9217，I2C（SDA=8/SCL=7）、INT=GPIO5、RST=GPIO11 |
| 电源 | AXP2101（ALDO3 作为面板复位轨） |
| IMU / 音频 | QMI8658 / ES8311 + ES7210（I2S TDM，16 kHz stereo） |
| 连接 | USB Serial/JTAG（VID 0x303A，COM3） |

### 1.3 当前完成度与验证状态

| 项 | 状态 |
| --- | --- |
| 代码审计（对照官方 C6 2.06 BSP、09 示例、出厂固件、社区同板实现） | ✅ 完成，见 [`firmware-audit.md`](firmware-audit.md) |
| 本机 IDF 构建 | ✅ 绿，`firmware/build/codex_air_remote.bin` ≈ 2.32 MB |
| `env/` 内 IDF 构建 | ✅ 绿，日志 `firmware/build/env-build.log`（0 error） |
| 架构重构 | ✅ `main/` 仅编排；组件 `bsp_board`、`app_ui`、`app_mouse`、`app_voice`、`app_provision`、`codec_board` |
| 临时探针清理 | ✅ 已清理（保留 AR1V 串口语音触发，供待实测清单使用） |
| 实机：烧录 / 启动 | ✅ `AR1 READY 7`、`AIRREMOTE UI READY; IMU=1 BLE=1 VOICE=1 PMIC=1`、`BLE HID started`、`BLE advertising started`，无 panic |
| 实机：屏幕点亮 | ⏳ **待用户确认**（若黑屏，按第 3.7 节切引脚 B 变体） |
| 实机：触摸/亮度/BLE 配对/鼠标/语音 E2E | ⏳ 待测，见待实测清单 |

> 结论：代码层面 **Go**（双构建绿、探针清理、审计完成）；实机验证仍在进行中。

### 1.4 关键设计决策

1. **协议**：TLS 1.2 + ECDSA P-256 双向证书；板端软件 AES（关闭 `CONFIG_MBEDTLS_HARDWARE_AES`，省 DMA/IRAM）；WSS 文本 JSON 信令 + 二进制 PCM 帧。
2. **BLE ↔ Wi-Fi 互斥**：语音会话前释放 BLE（HID 报告停止），会话结束后恢复；避免 C6  coexistence 抖动与内存峰值。
3. **单播发现**：板端向 PC 网关 `47682` 发 `AR1A`+MAC 单播（不用广播），PC 端绑定 `0.0.0.0:47682` 接收。
4. **BLE HID 修复**：`esp_ble_gatts_register_callback(esp_hidd_gatts_event_handler)`（esp_hid BLE 传输层不注册会永不广播）；CCC 就绪探测 500 ms 退避 + 位移丢弃 + 按键状态对账。
5. **显示/电源参照**：以官方 C6 2.06 BSP + 同板可用实现 `mfellner/esp32-playground` 为准；PMU 只动 ALDO3 面板复位轨（不写 DC1/ALDO1/2/4/VBUS/充电）。
6. **引脚 A/B 变体**：引脚集中在 `firmware/components/bsp_board/include/board_pins.h`，默认 A（CS=15/INT=5），`CONFIG_BOARD_LCD_PINS_VARIANT_B=y` 切 B（CS=5/INT=15）。
7. **官方目录布局 + env 分离**：`firmware/` 为 IDF 工程（`main/` + `components/`），`env/` 只放环境（gitignore）。

## 2. 换电脑继续开发

### 2.1 获取代码

仓库远端（当前唯一远端）：

```text
origin  https://github.com/grassoflty-dev/CodexAirRemote.git
分支    main
```

当前所有改动已在本地提交（**未 push**）。迁移代码二选一：

**方式 A（推荐）：推送后在新电脑克隆**

```powershell
# 旧电脑（凭据由用户提供：PAT / SSH key / git 凭据管理器）
git push origin main

# 新电脑
git clone https://github.com/grassoflty-dev/CodexAirRemote.git
cd CodexAirRemote
```

**方式 B：整目录拷贝**（无远端权限时）

```powershell
# 只拷源码（env/build 很大，可不拷，见 2.2）
robocopy "E:\Develop\CodexAirRemote" "F:\CodexAirRemote" /E /XD env firmware\build firmware_s3\build windows\.venv windows\.local tools\eim archive
```

> 注意：`firmware/managed_components/` 与 `firmware/build/` 是构建产物，可不拷，首次构建会自动重新下载/生成。

### 2.2 恢复 `env/`（ESP-IDF 5.5.5 + 工具链，约 8 GB，不入库）

二选一：

**方式 A（推荐）：从旧电脑整目录拷贝**

```powershell
robocopy "E:\Develop\CodexAirRemote\env" "F:\CodexAirRemote\env" /E
```

**方式 B：按官方源重装**
按 [`development-environment.md`](development-environment.md) 安装 ESP-IDF v5.5.5 与 EIM 工具链到
`env/esp-idf` 与 `env/espressif/tools`（保持目录结构，`env/activate.ps1` 依赖该布局）。

### 2.3 打开工程

- **VS Code（多根工作区）**：打开 `CodexAirRemote.code-workspace`，`firmware/` 是 IDF 工程；
  安装 ESP-IDF 扩展（`espressif.esp-idf-extension`），设置：
  - `idf.eimIdfJsonPath` → `<repo>\env\eim_idf.json`
  - `idf.currentSetup` → 选择该 eim 配置中的 setup
- **命令行**：

```powershell
cd <repo>
. .\env\activate.ps1
idf -C firmware build
idf -C firmware -p COM3 flash monitor
```

### 2.4 不入库内容与恢复

| 路径 | 内容 | 新电脑怎么办 |
| --- | --- | --- |
| `env/` | IDF + 工具链 + Python 环境 | 拷贝或按官方源重装（2.2） |
| `firmware/build/`、`firmware/managed_components/`、`firmware/sdkconfig` | 构建产物/组件缓存/本机构建配置 | 重新 `idf -C firmware build` 自动生成；组件自动下载 |
| `windows/.venv/` | Python 虚拟环境 | `windows\Setup-Dev.ps1` 重建并安装 requirements |
| `windows/.local/` | TLS 证书 `server.crt/server.key`、`pairing.txt`、`network.json`、`backups/`、日志 | **重新生成**：`python windows\tools\init_pairing.py`（或 `windows\Setup-Dev.ps1`）；然后重新配网、重新 BLE 配对 |

> `windows/.local/backups/` 里有整片 flash 出厂备份（约 16 MB），**不要覆盖**；新电脑上没有这份备份时，
> 需要时用 `windows\host\flash.py` 先做一次备份再烧录自有固件。

### 2.5 Windows 辅助程序环境

```powershell
cd <repo>\windows
.\Setup-Dev.ps1            # 建 .venv、装 requirements、生成 .local 配对材料
.\Companion.cmd            # 启动 companion（语音桥）
```

依赖：Python **3.12**（3.13 缺 `audioop`）、VB-CABLE、Codex 桌面版；可选 DSH + SenseVoice（见 `docs/voice-targets.md`）。

## 3. 新电脑首次跑通流程

1. **编译**：`. .\env\activate.ps1; idf -C firmware build`（0 error）。
2. **烧录**：`idf -C firmware -p COM3 flash`（或 `windows\Flash.cmd`）。
3. **看屏**：应显示 UI（BLE/电量状态 + Gyro/Voice/A/B）。**若黑屏先按 3.7 切引脚 B**。
4. **重新配网**：`windows\Companion.cmd` → 界面或 `python windows\host\flash.py --provision-only` 写入 Wi-Fi（热点 `AirRemote-XXXX`）。
5. **BLE 配对**：Windows 设置 → 蓝牙 → 添加设备 → `Codex Air Remote`（需要用户点配对弹窗）。
6. **鼠标/A/B**：点击 Gyro → 倾斜控制光标；A=左键、B=右键（测试时别碰物理鼠标）。静止漂移大 → 需重新校准/检查 IMU。
7. **语音（Codex）**：点击 Voice → 说话 → A 发送；确认 Codex 窗口收到听写文本。
8. **语音（DSH，可选）**：先按 `docs/voice-targets.md` 配置 SenseVoice + CABLE Output，再在辅助程序切换目标。

### 3.1 常见问题

| 现象 | 排查 |
| --- | --- |
| 屏幕全黑 | 先切引脚 B：`sdkconfig.defaults` 加 `CONFIG_BOARD_LCD_PINS_VARIANT_B=y` 重新编译烧录；仍黑见审计报告遗留风险 |
| 触摸偏移/镜像 | 调整 `bsp_board/display_bsp.cpp` 的 `swap_xy` / `mirror_x` / `mirror_y` |
| BLE 搜不到/不广播 | 看日志是否有 `BLE HID started`、`BLE advertising started`；`btm_ble_write_adv_enable_complete failed` 偶发告警可重试 |
| 鼠标不动 | 确认已配对、看 `HID reports enabled by host`；Windows 不写 CCC 时需移除设备重新配对 |
| 语音连不上 | 检查热点、`network.json`、companion 日志；TLS 证书是否重新生成 |
| 内存不足/panic | 看 `heap after ...` 日志；LVGL 栈/缓冲、语音 PCM 缓冲需按实测调整 |

### 3.2 待实测清单与审计

- 待实测项与回退方案：[`pending-hardware-validation.md`](pending-hardware-validation.md)
- 审计结论与遗留风险：[`firmware-audit.md`](firmware-audit.md)
- 引脚 A/B 变体：`firmware/components/bsp_board/include/board_pins.h` 文件头注释（来源与依据）

## 4. Git 工作流建议

- **分支**：`main` 保持可构建；功能/实验用 `feat/<主题>`、修复用 `fix/<主题>`。
- **提交信息**：`<类型>: <摘要>`，例如 `feat(firmware): add app_ui component`、`docs: document development environment`。
- **不要提交**：`env/`、`firmware/build/`、`firmware/managed_components/`、`firmware/sdkconfig`、`windows/.venv/`、`windows/.local/`、证书/密钥/固件备份/日志/录音（`.gitignore` 已覆盖）。
- **推送**：

```powershell
git remote -v                     # 确认远端
git push origin main              # 首次推送（凭据由用户提供）
```

- **换机同步建议**：先 `git push`，新电脑 clone；`env/` 用移动硬盘/局域网整目录拷贝（8 GB，比重新下载快且版本一致）。
