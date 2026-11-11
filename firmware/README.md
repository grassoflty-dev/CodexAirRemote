# ESP32-C6 固件

`firmware/` 是 Codex Air Remote 的板端工程，目标硬件为微雪 **ESP32-C6-Touch-AMOLED-2.16**（电池款），使用 **ESP-IDF 5.5.5** 构建。固件提供 480×480 触屏界面、蓝牙 HID 空中鼠标、Wi-Fi + HTTPS/WebSocket 语音通道和 USB Serial/JTAG 配网。Windows 侧程序见 [../windows/README.md](../windows/README.md)，S3 迁移细节见 [../docs/firmware-c6-migration.md](../docs/firmware-c6-migration.md)。

> **状态**：ESP-IDF 5.5.5 编译干净（应用镜像约 2.3 MB，8 MB 应用分区占用约 28%），已实测到 `AR1 READY 7`、显示/触摸/PMU/音频/IMU 正常，语音链路已验证到
> `UDP 发现 → TLS 1.2 → WebSocket → AUTH/READY2 → CAPTURE/GO → 麦克风 PCM 帧`。2026-11-09 代码轮修复了 **BLE HID 从不广播**的根因（缺少 GATTS 回调注册）并加固了按键/释放逻辑、语音会话的 Wi-Fi 省电模式；
> 这些改动与 A/B 按键、空中鼠标的手感仍需接板实测确认，逐项步骤见 [`docs/pending-hardware-validation.md`](../docs/pending-hardware-validation.md)。

## 目标板

| 项目 | 规格 |
| --- | --- |
| MCU | ESP32-C6，单核 RISC-V，160 MHz，512 KB SRAM，**无 PSRAM** |
| Flash | 16 MB，自定义分区表 |
| 显示 | 480×480 AMOLED，SH8601，QSPI；无独立复位脚，靠 AXP2101 ALDO3 断电复位 |
| 触摸 | CST9217，I2C 地址 `0x5A`，`swap_xy=1`、`mirror_y=1` |
| 电源 | AXP2101（`0x34`），支持电池检测、充电配置和 ALDO3 面板电源 |
| 音频 | ES8311 扬声器 + ES7210 麦克风，I2S TDM，16 kHz 立体声 |
| 传感器 | QMI8658 六轴 IMU（加速度计 + 陀螺仪） |
| USB | 原生 USB-Serial/JTAG，VID:PID `303A:1001`，同时作为控制台和配网通道 |
| 按键 | 无硬件复位键 |

## 目录

| 路径 | 内容 |
| --- | --- |
| `main/app_main.c` | UI 布局、四个触摸按钮、状态文字、亮度与电量刷新、初始化顺序 |
| `main/air_mouse.c` | QMI8658 采集、静止校准、姿态解算、灵敏度/死区/方向 |
| `main/ble_mouse.c` | Bluedroid BLE HID 鼠标、广播、配对与重连 |
| `main/voice.c` | Wi-Fi STA、UDP 发现、TLS WebSocket、录音与协议状态机 |
| `main/provision.c` | USB Serial/JTAG 命令行配网，Wi-Fi 配置存 NVS |
| `main/CMakeLists.txt` | 源文件、依赖组件、内嵌证书/密钥/令牌 |
| `main/idf_component.yml` | 托管组件清单 |
| `components/bsp_port/` | I2C、SH8601 QSPI 显示、CST9217 触摸、AXP2101 电源（XPowersLib）、ES8311/ES7210 音频 |
| `components/bsp_app/` | `esp_lv_adapter` + LVGL 9 移植、显示/触摸注册、锁 |
| `components/board/` | 对 `main/` 暴露的 C 接口：`board_init`、`board_display`、`board_lock`、`board_i2c_bus`、`board_set_brightness`、`board_battery_*`、`board_microphone` |
| `components/codec_board/` | 来自 Espressif 的 ES8311/ES7210 初始化组件（Vendor 化） |
| `docs/reference/esp_hid_device_example/` | ESP-IDF BLE HID 设备示例，仅作接口参考 |
| `Build.ps1` | 激活 ESP-IDF → 准备配对材料 → `idf.py build` → 生成发布清单 |
| `Idf.ps1` | 复用激活逻辑的 `idf.py` 包装，供 menuconfig/monitor/fullclean 使用 |
| `partitions.csv` | 16 MB Flash 分区表 |
| `sdkconfig.defaults` | 目标、Flash、控制台、蓝牙、Wi-Fi、LVGL 默认配置 |
| `CMakeLists.txt` | `set(IDF_TARGET "esp32c6")` |
| `build/` | 构建产物（忽略，不提交） |
| `managed_components/` | 托管组件缓存（忽略，不提交） |

## 组件

| 组件 | 版本 | 作用 |
| --- | --- | --- |
| `lvgl/lvgl` | `^9.5`，实解析 9.6.0~1 | 图形界面 |
| `espressif/esp_lcd_sh8601` | 1.0.0 | AMOLED 面板驱动 |
| `waveshare/esp_lcd_touch_cst9217` | 1.0.4 | 触摸驱动 |
| `espressif/esp_lvgl_adapter` | 0.3.2 | LVGL 显示/触摸适配与任务 |
| `waveshare/qmi8658` | 2.0.2 | IMU 驱动 |
| `espressif/esp_codec_dev` | 1.4.0 | ES8311/ES7210 统一音频接口 |

托管组件由组件管理器在首次构建时下载；实际版本锁定在 `dependencies.lock`。内置组件（`bsp_port`、`bsp_app`、`board`、`codec_board`）随仓库提供，不依赖网络。

## 构建

前置条件：

- Windows 上已安装 ESP-IDF **5.5.5**，默认激活脚本为 `C:\Espressif\tools\Microsoft.v5.5.5.PowerShell_profile.ps1`。
- 已运行过 `windows\Setup-Dev.ps1`，`windows/.venv` 与 `windows/.local` 存在。固件会把 `.local` 中的 `server.crt`、`server.key`、`pairing.txt` 编进镜像；缺失时 CMake 直接报错。

```powershell
# 仓库根目录
powershell -ExecutionPolicy Bypass -File .\firmware\Build.ps1
```

`Build.ps1` 的步骤：

1. 若未设置 `$env:IDF_PATH`，加载默认激活脚本；也可用 `-IdfActivate` 或环境变量 `AIRREMOTE_IDF_ACTIVATE` 指定。
2. 调用 `windows/.venv` 中的 Python 运行 `windows/tools/init_pairing.py`，确保配对材料存在。
3. 运行 `idf.py build`，日志写入 `firmware/build/build.log`。
4. 读取 `build/flasher_args.json`，对每个镜像计算 SHA-256，生成 `build/airremote-release.json`。

VS Code 中打开 `firmware` 根后可用任务：

| 任务 | 作用 |
| --- | --- |
| 固件：编译 | 默认构建任务，等价于 `Build.ps1` |
| 固件：menuconfig | `Idf.ps1 menuconfig` |
| 固件：串口监视 | `Idf.ps1 monitor` |
| 固件：全量清理 | `Idf.ps1 fullclean` |

### 构建产物

| 文件 | 烧录地址 |
| --- | --- |
| `build/bootloader/bootloader.bin` | `0x0` |
| `build/partition_table/partition-table.bin` | `0x8000` |
| `build/ota_data_initial.bin` | `0x10d000` |
| `build/codex_air_remote.bin` | `0x200000` |
| `build/airremote-release.json` | SHA-256 清单，Windows 烧录前校验 |

不要手工修改或单独分发 `build/`：镜像内嵌本机 TLS 私钥和配对令牌。

## 烧录

推荐用 Windows 辅助程序烧录，它会先备份 16 MB 原始 Flash，再按上表地址写入并校验，最后通过 USB 完成配网：

```powershell
windows\Flash.cmd
```

也可以打开 `windows\Companion.cmd`，点「烧录开发板」。烧录工具为 esptool，参数为 `--chip esp32c6 --baud 921600 --flash-mode dio --flash-size 16MB --flash-freq 80m`。镜像地址与 `windows/host/flash.py` 中的常量一一对应，修改分区表时必须同步修改该脚本。

板端没有硬件复位键。无法进入下载模式时，按住 BOOT 后重新上电或短按 RESET（如板上有），再松开 BOOT。

## 分区与镜像

`partitions.csv`（16 MB）：

| 名称 | 类型 | 偏移 | 大小 | 用途 |
| --- | --- | --- | --- | --- |
| `nvsfactory` | data/nvs | `0x9000` | 200 KB | 原厂 NVS 数据区 |
| `nvs` | data/nvs | `0x3B000` | 840 KB | 应用 NVS（Wi-Fi 配置等） |
| `otadata` | data/ota | `0x10D000` | 8 KB | OTA 选择数据 |
| `phy_init` | data/phy | `0x10F000` | 4 KB | RF 校准数据 |
| `model` | data/spiffs | `0x110000` | 960 KB | 模型/资源预留 |
| `factory` | app/factory | `0x200000` | 8 MB | 应用镜像 |
| `storage` | data/spiffs | `0xA00000` | 6 MB | 预留存储 |

应用只使用 `factory` 分区，当前没有启用 OTA 升级；`otadata` 仍按固定地址写入初始数据，以匹配 Windows 烧录脚本的布局检查。

## USB 控制台与配网

板端把原生 USB-Serial/JTAG 同时用作日志控制台和配网通道（`CONFIG_ESP_CONSOLE_USB_SERIAL_JTAG=y`），默认 115200 波特率、8N1。

### 命令

| 命令 | 响应 | 说明 |
| --- | --- | --- |
| `AR1?` | `AR1 READY <flags> <12 位 hex MAC>` | 查询就绪状态与蓝牙 MAC；板级初始化完成后才响应 |
| `AR1W <ssid hex> <password hex>` | `AR1 WIFI OK` / `AR1 WIFI INVALID` / `AR1 WIFI STORE FAILED` | 把 Wi-Fi 配置写入 NVS |
| `AR1V` | `AR1 VOICE STARTED` / `AR1 VOICE BUSY` | **临时调试入口**：经 USB 启动一次语音会话（无头实测用，见 `docs/pending-hardware-validation.md`）；最终交付前再决定是否移除 |
| `AR1T <unix 秒>` | `AR1T OK <unix>` / `AR1T ERR` | 设置板端时间：写入 PCF85063A（掉电保持）并同步系统时钟；左上角时钟立即刷新 |

- `<flags>` 是位掩码：bit0 = IMU 就绪，bit1 = BLE 就绪，bit2 = 语音就绪；`7` 表示全部就绪，`0` 表示板级初始化失败。
- `AR1T` 的参数是 **UTC unix 秒**（无符号十进制，2024–2099 之外视为非法）。板端 RTC 只存本地墙上时间，默认按 **UTC+8** 换算（`components/rtc_board/rtc_board.c` 顶部 `RTC_TZ_OFFSET_SEC` 是唯一定义处）；系统时钟 `time()` 保持 UTC。
- SSID 和密码都用十六进制表示，按字节编码；SSID 1–32 字节，密码 8–63 字节。密码可传 `-` 表示空（开放网络）。
- 命令以 `\n` 结尾，`\r` 会被忽略；单行上限 219 字节。
- 配置保存在 NVS namespace `airremote`、key `wifi`，内容为 `wifi_sta_config_t`；重新配网会覆盖。
- Windows 的 `flash.py` 会反复发送 `AR1?` 直到收到 `AR1 READY 7 ...`，因此烧录后必须保证 IMU、BLE、语音三路都初始化成功。

配网信息只在下次点 Voice 时使用，写入后无需重启。

## 运行时与界面

`app_main` 的初始化顺序（受 512 KB 无 PSRAM 约束，顺序不能随意调整）：

1. 读取并打印 Flash 大小与内部空闲堆。
2. `nvs_flash_init`，随后启动 USB 配网任务。
3. `voice_init`：在堆还完整时分配 16 KB 语音 PCM 环形缓冲。
4. `board_bus_init`：I2C → AXP2101（面板 ALDO3 供电）。
5. `rtc_board_init`：PCF85063A 实时时钟（同一 I2C0 总线，0x51），起振并把 RTC 时间读出来给左上角时钟。
6. `mouse_init`：QMI8658（IMU）。
7. `board_audio_init`：ES8311/ES7210 与 I2S DMA。
8. `board_display_start`：SH8601 AMOLED + CST9217 触摸 + LVGL 适配器（绘制缓冲与 LVGL 堆在此占用内部 RAM）。
9. `ble_mouse_init`：Bluedroid + HID，最后才构建 UI，并通过 `provision_report_board` 上报就绪位。
   语音会话开始时释放 BLE 换 Wi-Fi/TLS 内存，结束后恢复。

界面布局（480×480）：

| 元素 | 位置/尺寸 |
| --- | --- |
| 时钟 `HH:MM`（原标题位） | 左上 `(24, 27)`，Montserrat 28 |
| BLE 状态 | 左上 `(25, 69)` |
| 电量 | 右上 `(-25, 69)` |
| Voice 按钮 | `(42, 112)`，150×112 |
| Gyro 按钮 | `(288, 112)`，150×112 |
| A 按钮 | `(42, 252)`，150×112 |
| B 按钮 | `(288, 252)`，150×112 |
| 状态文字 | 居中，`y=404`，宽 420，自动换行 |

- 两个模式互斥，模式按钮在另一模式进行中禁用。
- 亮度在活动/录音时为 70，空闲 25 秒后降到 24。
- 电量每秒通过 AXP2101 刷新；无电池时显示 `--`。
- 左上角时钟：有系统时间（`AR1T` 之后，UTC+8）就按 `time()` 格式化，否则每约 1 秒读一次 PCF85063A；两者都不可用时显示 `--:--`。`render()` 里 1 秒采样一次，且只在 `HH:MM` 真正变化时才 `lv_label_set_text`。
- UI 刷新定时器 125 ms，渲染时同步 A/B 按钮的可用状态和提示文字。

## 蓝牙 HID 鼠标

- 设备名 `Codex Air Remote`，厂商 `Air Remote`，VID/PID `0x02E5/0xA180`，HID 鼠标报告 4 字节（按键、X、Y、滚轮）。
- Bluedroid + BLE 4.2 特性集（legacy advertising），BLE 5.0 关闭；使用 HID 服务 UUID `0x1812` 广播，扫描响应包含设备名。
- 配对使用 LE Secure Connections + bonding，IO capability 为 `NoInputNoOutput`；断开后自动重新广播。
- **关键点：`ble_mouse.c` 必须显式调用 `esp_ble_gatts_register_callback(esp_hidd_gatts_event_handler)`。**
  ESP-IDF 5.5 的 `esp_hid` BLE 传输层不会自行注册该回调（官方 `esp_hid_device` 示例也是在应用层注册）；
  缺少这一步时 GATTS 建表事件全部丢失，`ESP_HIDD_START_EVENT` 永不触发，板子**永远不会开始广播**，
  Windows 也就永远搜不到设备。2026-11-09 之前的所有 C6 构建都存在这个问题。
- 正常启动日志应出现 `ble_mouse: BLE HID started` 与 `ble_mouse: BLE advertising started`；
  连接/配对/断开分别打印 `BLE host connected`、`BLE pairing complete`、`BLE host disconnected`。
  若 1 s 内没等到 START 事件，兜底定时器会打印 `HID start event missing, not advertising`：**不会**伪造
  HID 服务强行广播（否则 Windows 会配到一个没有 HID 服务的设备），只作为诊断提示。
- **报告与释放的并发安全**：`esp_ble_hidd_dev_input_set()` 内部用无超时信号量等待 ATT confirm（`WAIT_CB`），
  链路半死时会永久阻塞。`ble_mouse_report()` 用互斥量 + 短超时串行化，`ble_mouse_release()` 先置
  `linked=false`/`releasing` 再最多等 250 ms；若报告仍卡在协议栈里，释放会失败（日志
  `HID report still in flight, keeping the BT stack up`）并让本次语音会话以 `NETWORK_ERROR` 中止，
  避免 `esp_hidd_dev_deinit()` 删除被阻塞的信号量/释放设备造成 use-after-free。该极端情况需要重启板子恢复。
- `ble_mouse_init()` 按阶段记录 controller/host 初始化状态，任一步失败都会回滚；`release()` 可在任意
  初始化阶段后安全调用，重复调用无副作用。
- QMI8658 以 250 Hz 输出加速度和角速度，采样任务 4 ms 一次；进入 Gyro 后先做约 0.8 秒静止校准，校准失败或 15 秒内未完成会提示重试。
- 按键语义：鼠标模式下 A/B 对应左/右键的按下与释放（LVGL `press_lock` 保证按下后不会误切到别处，抬手必定收到
  `RELEASED` 或 `PRESS_LOST`）；`air_mouse.c` 每约 2 s 对账一次按键状态，防止事件丢失造成卡键。
- 灵敏度、死区、X/Y 方向集中在 `main/air_mouse.c` 顶部常量；修改后需重新编译固件。

## 语音链路

1. 点 Voice 后 `voice_task` 读取 NVS 中的 Wi-Fi 配置，`esp_wifi_start` 后最多重连 2 次、每次等待 25 秒获取 IP。
2. 启动 WSS 服务（端口 47683，证书和私钥来自固件内嵌；**只启用 TLS 1.2**，PC 端必须同样锁定 TLS 1.2）并打开 UDP 47682 发现套接字。
3. Windows 移动热点**不转发主机的广播**，因此发现改为双向：PC 侧绑定 `0.0.0.0:47682` 并广播 `AR1?`+16 字节随机数；
   板端在等待客户端期间每约 500 ms 向网关（热点主机，如 `192.168.137.1`）**单播** `AR1A`+6 字节 STA MAC，同时保留广播应答
   `AR1!`+同一随机数作为普通 AP 环境的后备。PC 收到任一即可连接 `wss://<板端 IP>:47683/voice`。
4. Windows 首帧发送 `AUTH <64 位 hex 令牌>`，板端比较后回 `READY2`；Windows 再发 `CAPTURE`，板端回 `GO`。
5. `capture_task` 从 ES7210 读取 **16 kHz 立体声** 1280 字节，按左右声道求平均下混成 640 字节单声道，写入 16 KB 环形缓冲；录音上限 60 秒。
6. Windows 反复发 `PULL`；板端每次最多回 2 帧（4 字节大端序号 + 640 字节 PCM），暂无数据回 `WAIT`。
7. 用户点 A/B 后，板端在 `PULL` 响应中发送 `SEND` 或 `CANCEL`；Windows 完成 Codex 听写操作后回 `SUBMITTED`、`DRAFTED`、`CANCELLED`、`SAVED`、`EMPTY`、`FAILED` 或 `ABORT`，板端回 `ACK` 并显示结果。
8. 会话期间调用 `esp_wifi_set_ps(WIFI_PS_NONE)`：协议是严格一问一答（PULL → 帧），modem sleep 的 DTIM 唤醒会让
   每次往返多等 100–300 ms，把可用拉取速率压到低于麦克风 32 KB/s 的产出速率，进而冲爆 16 KB 缓冲；会话很短，保持射频唤醒的功耗代价可以接受。
9. 为降低 USB-Serial/JTAG 控制台（256 B TX 缓冲）对 HTTP 服务的反压，音频帧日志降为「每秒 1 行 + 失败必打」，
   `PULL` 逐帧日志降为 DEBUG（`CONFIG_LOG_MAXIMUM_LEVEL=INFO` 时零开销）。

超时：发现/建立连接 20 秒，等待 `CAPTURE` 20 秒，结束后识别阶段 110 秒；连接中断、PC 服务未运行、Wi-Fi 不可用、麦克风错误都会映射到屏幕状态文字。语音会话期间会释放 Bluedroid（约 +52 KB 内部堆），结束后关闭 Wi-Fi/HTTPS 并恢复 BLE，下次点 Voice 重新开始。

## 内存约束

C6 没有 PSRAM，所有缓冲都在 512 KB 内部 SRAM 中，是整个移植最紧的资源：

| 用途 | 大小 |
| --- | --- |
| 语音 PCM 环形缓冲 | 16 KB（`voice.c` 中 `BUFFER_BYTES`，约 0.5 秒单声道；启动时分配） |
| LVGL 绘制缓冲 | 480 × 8 × 2 = 7.5 KB，单缓冲 |
| LVGL 堆 | 20 KB（`CONFIG_LV_MEM_SIZE=20480`） |
| LVGL 任务栈 | 8 KB（优先级 8） |
| `main` / `mic_capture` 任务栈 | 8 KB / 8 KB |
| `voice` / `air_mouse` / `usb_config` 任务栈 | 6 KB / 4 KB / 4 KB |
| HTTPS 服务栈 | 10 KB（`httpd.stack_size = 10240`） |
| Bluedroid 常驻堆 | 约 52 KB；语音会话期间 `ble_mouse_release()` 释放，结束后恢复 |

启动空闲时内部堆约 **23–27 KB**（修复 BLE 根因后 GATTS 属性表会真实建表，比旧日志少几 KB）；语音会话释放 BLE 后约 **79 KB**，Wi-Fi + TLS 起来后约 **36 KB**。
启动日志会打印 `heap after <阶段> free=... min=...`；出现内存不足时优先降低语音缓冲、LVGL 缓冲高度或字体数量，而不是增大栈。
Wi-Fi 与 BLE 交替使用是本项目在 512 KB 无 PSRAM 下的核心约束：鼠标模式只开 BLE，语音模式释放 BLE 换 Wi-Fi/TLS，两者不要同时常驻。

## 常见问题

| 现象 | 处理 |
| --- | --- |
| CMake 报 `Missing .../windows/.local/server.crt` | 先运行 `windows\Setup-Dev.ps1`，或直接跑 `firmware\Build.ps1`（它会准备材料） |
| CMake 报某个组件 include 目录不存在 | 停掉并发的构建，删除 `firmware/build` 与 `firmware/managed_components` 后重新构建（二者都是生成目录） |
| 首次构建卡在下载组件 | 组件管理器需要联网；失败后重试即可，已下载部分会复用 |
| `idf.py build` 失败 | 查看 `firmware/build/build.log` 或 VS Code 任务输出中的首个 `error:` |
| 烧录时报不是 16 MB Flash | 确认板子型号是 ESP32-C6-Touch-AMOLED-2.16；不是同款不要写入 |
| 烧录后黑屏 | 查看串口日志是否有 `BSP could not start the panel and touch`；检查 AXP2101 与 ALDO3 供电，必要时重新上电 |
| 触摸方向或位置不对 | 调整 `components/bsp_port/display_bsp.cpp` 中 `swap_xy`、`mirror_x`、`mirror_y`（当前为 `1/0/1`），重新编译 |
| 录音无声或只有单声道 | ES7210 的 TDM 通道顺序可能与下混假设不同，检查 `voice.c` 的左右声道选择与增益 |
| 亮度调节无效果 | SH8601 使用 `0x51` 命令写亮度；若面板不响应，可改用初始化命令中的亮度寄存器或固定值 |
| Windows 提示 `AR1 READY 0` 或硬件初始化错误 | BSP、IMU、BLE 或语音至少一路初始化失败；看串口日志中的 `AIRREMOTE UI READY; IMU=? BLE=? VOICE=? PMIC=?` |
| 蓝牙搜不到或配对失败 | 先看串口是否有 `BLE HID started` + `BLE advertising started`：缺前者说明 GATTS 回调未注册（见上文「蓝牙 HID 鼠标」），缺后者看 `Advertise: ...` 错误；出现 `HID start event missing, advertising anyway` 说明走了兜底。板子在语音会话期间会释放 BLE，此时搜不到是正常的 |
| 光标能连上但不移动 | 看屏幕是否 `Mouse active`（校准完成）、板端是否 `BLE host connected`；用 `firmware/build/mouse_probe.py` 观察 Windows 侧光标与按键 |
| A/B 卡键 | 板端 `air_mouse.c` 每约 2 s 对账按键状态；若仍卡住，检查 BLE 是否断开（断开会复位按键并重发释放报告） |
| Voice 显示 `PC companion unavailable` | Windows 服务未运行、防火墙拦截、两端不在同一网段，或热点未开启；先启动辅助程序服务 |
| Voice 显示 `Wi-Fi unavailable` | NVS 中没有有效配置；重新运行「只重新配网」 |
| 长时间录音后断流 | 检查内部堆余量与 Wi-Fi 信号；16 KB 缓冲约 0.5 秒，PC 端拉取过慢会触发 `PCM buffer full` → `Audio connection lost`；确认会话期间没有回到 modem sleep |

## 安全

- 构建出的 `codex_air_remote.bin` 内含本机 TLS 私钥与配对令牌；不要提交、上传或跨机器复用。换机器后重新生成材料并重刷板端与 Windows 程序。
- `firmware/build/`、`firmware/managed_components/`、`firmware/sdkconfig` 都是生成内容，已在 `.gitignore` 中。
- 固件不包含云端凭证，也不直接调用 Codex 服务；语音只通过局域网送到 Windows，由辅助程序交给桌面听写。

## 工程结构（官方布局 + env 分离）

```
firmware/
├─ CMakeLists.txt / partitions.csv / sdkconfig.defaults
├─ main/                 # 仅入口编排（app_main.c）与依赖清单（idf_component.yml）
└─ components/
   ├─ bsp_board/         # 板级：显示/触摸/PMU/IMU/音频编解码适配（含 board_pins.h）
   ├─ app_mouse/         # QMI8658 陀螺仪 + BLE HID 鼠标
   ├─ app_voice/         # TLS/WSS 语音链路、单播发现、录音/推流
   ├─ app_provision/     # USB Serial/JTAG 配网与串口命令
   ├─ rtc_board/         # PCF85063A 实时时钟（I2C 0x51）与本地时间格式化
   └─ codec_board/       # 编解码板级配置（board_cfg.txt）
env/                     # 环境配置（gitignore）：ESP-IDF 5.5.5 + 工具链，见 env/README.md
```

## 功能 → 组件 → 文件对照

| 功能 | 组件 | 关键文件 |
| --- | --- | --- |
| 显示（SH8601 QSPI）/ 面板复位（ALDO3） | `bsp_board` | `display_bsp.cpp`、`board.cpp`、`include/board_pins.h` |
| 触摸（CST9217 I2C + INT/RST） | `bsp_board` | `display_bsp.cpp` |
| PMU/电池（AXP2101） | `bsp_board` | `power_bsp.cpp`（只动 ALDO3 面板复位轨） |
| IMU（QMI8658） | `bsp_board`/`app_mouse` | `board.cpp`（总线）、`app_mouse/air_mouse.c` |
| 实时时钟（PCF85063A、掉电保持、`HH:MM`） | `rtc_board` | `components/rtc_board/rtc_board.c`、`include/rtc_board.h` |
| 陀螺仪空中鼠标 / A-B 按键 | `app_mouse` | `air_mouse.c`、`air_mouse.h` |
| BLE HID（GATTS 回调、CCC 就绪、按键对账、release/resume） | `app_mouse` | `ble_mouse.c`、`ble_mouse.h` |
| LVGL UI（状态/Gyro/Voice/A/B、亮度息屏、左上角时钟） | `app_ui` | `components/app_ui/app_ui.c` |
| 语音链路（TLS1.2/WSS、单播发现、WIFI_PS_NONE、PCM 帧） | `app_voice` | `voice.c`、`voice.h` |
| 配网 / 串口命令（含 AR1V 语音触发） | `app_provision` | `provision.c`、`provision.h` |
| 音频编解码（ES8311/ES7210、I2S TDM） | `bsp_board`/`codec_board` | `codec_bsp.cpp`、`codec_board/` |

## 环境与构建

- **环境（env/，不进 git）**：ESP-IDF 5.5.5 + Espressif 工具链，说明见 [`../env/README.md`](../env/README.md)。
- 命令行：

```powershell
. .\env\activate.ps1
idf.py -C firmware build
idf.py -C firmware -p COM3 flash monitor
```

- VS Code：用 ESP-IDF 扩展打开 `firmware/` 作为工程，`idf.eimIdfJsonPath` 指向 `env/eim_idf.json`，`idf.currentSetup` 选择 env 的 setup。

## 显示引脚 A/B 变体（待实测确认）

`components/bsp_board/include/board_pins.h` 集中定义引脚。默认 **变体 A：LCD CS=GPIO15 / 触摸 INT=GPIO5**（社区同板实现与 09 示例默认值一致）。若实测黑屏，改 `sdkconfig.defaults`：

```
CONFIG_BOARD_LCD_PINS_VARIANT_B=y
```

即切到 **变体 B：CS=GPIO5 / INT=GPIO15**（官方 C6 2.06 BSP 用法），重新编译烧录即可，无需改其它代码。

## 审计

对照官方与社区同板实现的逐项审计、问题清单与 Go/No-Go 结论见
[`../docs/firmware-audit.md`](../docs/firmware-audit.md)。

## 开发环境与官方来源

IDF / 驱动组件的版本与官方下载链接（含 `env/` 准备步骤、`idf_component.yml` 实际解析版本）见
[`../docs/development-environment.md`](../docs/development-environment.md)。
