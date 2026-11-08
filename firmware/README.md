# ESP32-C6 固件

`firmware/` 是 Codex Air Remote 的板端工程，目标硬件为微雪 **ESP32-C6-Touch-AMOLED-2.16**（电池款），使用 **ESP-IDF 5.5.5** 构建。固件提供 480×480 触屏界面、蓝牙 HID 空中鼠标、Wi-Fi + HTTPS/WebSocket 语音通道和 USB Serial/JTAG 配网。Windows 侧程序见 [../windows/README.md](../windows/README.md)，S3 迁移细节见 [../docs/firmware-c6-migration.md](../docs/firmware-c6-migration.md)。

> **状态**：当前代码已用 ESP-IDF 5.5.5 编译通过（应用镜像约 2.3 MB，8 MB 应用分区占用约 28%），但尚未接开发板做实机验收；触摸方向、麦克风通道、亮度与内存余量等待上板确认的风险见迁移文档。

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

- `<flags>` 是位掩码：bit0 = IMU 就绪，bit1 = BLE 就绪，bit2 = 语音就绪；`7` 表示全部就绪，`0` 表示板级初始化失败。
- SSID 和密码都用十六进制表示，按字节编码；SSID 1–32 字节，密码 8–63 字节。密码可传 `-` 表示空（开放网络）。
- 命令以 `\n` 结尾，`\r` 会被忽略；单行上限 219 字节。
- 配置保存在 NVS namespace `airremote`、key `wifi`，内容为 `wifi_sta_config_t`；重新配网会覆盖。
- Windows 的 `flash.py` 会反复发送 `AR1?` 直到收到 `AR1 READY 7 ...`，因此烧录后必须保证 IMU、BLE、语音三路都初始化成功。

配网信息只在下次点 Voice 时使用，写入后无需重启。

## 运行时与界面

`app_main` 的初始化顺序：

1. 读取并打印 Flash 大小与内部空闲堆。
2. `nvs_flash_init`，随后启动 USB 配网任务。
3. `board_init`：I2C → AXP2101 → AMOLED + CST9217 → LVGL 适配器 → 音频 codec。
4. 初始化 IMU、BLE HID、语音子系统，构建 UI，最后通过 `provision_report_board` 上报就绪位。

界面布局（480×480）：

| 元素 | 位置/尺寸 |
| --- | --- |
| 标题 `Codex Air Remote` | 左上 `(24, 27)` |
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
- UI 刷新定时器 125 ms，渲染时同步 A/B 按钮的可用状态和提示文字。

## 蓝牙 HID 鼠标

- 设备名 `Codex Air Remote`，厂商 `Air Remote`，VID/PID `0x02E5/0xA180`，HID 鼠标报告 4 字节（按键、X、Y、滚轮）。
- Bluedroid + BLE 4.2 特性集（legacy advertising），BLE 5.0 关闭；使用 HID 服务 UUID `0x1812` 广播，扫描响应包含设备名。
- 配对使用 LE Secure Connections + bonding，IO capability 为 `NoInputNoOutput`；断开后自动重新广播。
- QMI8658 以 250 Hz 输出加速度和角速度，采样任务 4 ms 一次；进入 Gyro 后先做约 0.8 秒静止校准，校准失败或 15 秒内未完成会提示重试。
- 灵敏度、死区、X/Y 方向集中在 `main/air_mouse.c` 顶部常量；修改后需重新编译固件。

## 语音链路

1. 点 Voice 后 `voice_task` 读取 NVS 中的 Wi-Fi 配置，`esp_wifi_start` 后最多重试 3 次、每次等待 6 秒获取 IP。
2. 启动 WSS 服务（端口 47683，证书和私钥来自固件内嵌）并打开 UDP 47682 发现套接字。
3. Windows 广播 `AR1?` + 16 字节随机数，板端回复 `AR1!` + 同一随机数；随后 Windows 连接 `wss://<板端 IP>:47683/voice`。
4. Windows 首帧发送 `AUTH <64 位 hex 令牌>`，板端比较后回 `READY2`；Windows 再发 `CAPTURE`，板端回 `GO`。
5. `capture_task` 从 ES7210 读取 **16 kHz 立体声** 1280 字节，按左右声道求平均下混成 640 字节单声道，写入 48 KB 环形缓冲；录音上限 60 秒。
6. Windows 反复发 `PULL`；板端每次最多回 5 帧（4 字节大端序号 + 640 字节 PCM），暂无数据回 `WAIT`。
7. 用户点 A/B 后，板端在 `PULL` 响应中发送 `SEND` 或 `CANCEL`；Windows 完成 Codex 听写操作后回 `SUBMITTED`、`DRAFTED`、`CANCELLED`、`SAVED`、`EMPTY`、`FAILED` 或 `ABORT`，板端回 `ACK` 并显示结果。

超时：发现/建立连接 20 秒，等待 `CAPTURE` 20 秒，结束后识别阶段 110 秒；连接中断、PC 服务未运行、Wi-Fi 不可用、麦克风错误都会映射到屏幕状态文字。语音会话结束后会关闭 Wi-Fi 和 HTTPS 服务，下次点 Voice 重新开始。

## 内存约束

C6 没有 PSRAM，所有缓冲都在 512 KB 内部 SRAM 中，是整个移植最紧的资源：

| 用途 | 大小 |
| --- | --- |
| 语音 PCM 环形缓冲 | 48 KB（`voice.c` 中 `BUFFER_BYTES`，约 1.5 秒单声道） |
| LVGL 绘制缓冲 | 480 × 40 × 2 ≈ 38 KB，单缓冲 |
| LVGL 堆 | 32 KB（`CONFIG_LV_MEM_SIZE=32768`） |
| LVGL 任务栈 | 16 KB |
| `main` / `mic_capture` 任务栈 | 8 KB / 8 KB |
| `voice` / `air_mouse` / `usb_config` 任务栈 | 6 KB / 4 KB / 4 KB |
| HTTPS 服务栈 | 12 KB |

启动日志会打印 `Flash ... bytes; internal heap ... bytes free`；出现内存不足时优先降低语音缓冲、LVGL 缓冲高度或字体数量，而不是增大栈。Wi-Fi 与 BLE 同时工作、音频流和界面刷新叠加时余量最小，实机需要重点观察。

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
| 蓝牙搜不到或配对失败 | 确认 Windows 蓝牙已开启、设备未被其他主机占用；BLE 初始化失败时日志会打印 `BLE unavailable` |
| Voice 显示 `PC companion unavailable` | Windows 服务未运行、防火墙拦截、两端不在同一网段，或热点未开启；先启动辅助程序服务 |
| Voice 显示 `Wi-Fi unavailable` | NVS 中没有有效配置；重新运行「只重新配网」 |
| 长时间录音后断流 | 检查内部堆余量与 Wi-Fi 信号；48 KB 缓冲约 1.5 秒，PC 端拉取过慢会触发 `Audio connection lost` |

## 安全

- 构建出的 `codex_air_remote.bin` 内含本机 TLS 私钥与配对令牌；不要提交、上传或跨机器复用。换机器后重新生成材料并重刷板端与 Windows 程序。
- `firmware/build/`、`firmware/managed_components/`、`firmware/sdkconfig` 都是生成内容，已在 `.gitignore` 中。
- 固件不包含云端凭证，也不直接调用 Codex 服务；语音只通过局域网送到 Windows，由辅助程序交给桌面听写。
