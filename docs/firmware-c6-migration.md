# ESP32-S3 → ESP32-C6 迁移说明

本文记录 Codex Air Remote 从 ESP32-S3-Touch-AMOLED-1.8 迁移到 **ESP32-C6-Touch-AMOLED-2.16** 的实现约定、引脚与镜像地址，以及**尚未实机验证**的风险点。迁移前的 S3 工程归档在 `firmware_s3/`，不再参与构建。

> 本文描述的是迁移后的代码约定，不代表已在开发板上验收。上板前请按文末清单逐项确认。

## 迁移总览

| 维度 | ESP32-S3（`firmware_s3/`，归档） | ESP32-C6（`firmware/`，当前） |
| --- | --- | --- |
| 芯片 | ESP32-S3，双核 Xtensa LX7，240 MHz | ESP32-C6，单核 RISC-V，160 MHz |
| 内存 | 带 PSRAM（OCT） | **无 PSRAM**，512 KB SRAM |
| Flash | 16 MB | 16 MB |
| 屏幕 | 368×448 AMOLED | 480×480 AMOLED（SH8601 QSPI） |
| 触摸 | CST816S | CST9217（I2C） |
| 板级支持 | Waveshare BSP 2.0.3（托管组件） | 本地组件 `bsp_port`/`bsp_app`/`board`/`codec_board` |
| LVGL 适配 | BSP 内置 `esp_lvgl_port` | `espressif/esp_lvgl_adapter` 0.3.2 |
| 麦克风 | BSP 单声道 16 kHz | ES7210 TDM 立体声 16 kHz，软件下混 |
| 蓝牙 | Bluedroid BLE 4.2 | Bluedroid BLE 4.2（关闭 BLE 5.0） |
| ESP-IDF | 5.5.5 | 5.5.5 |
| 分区表 | 16 MB 固定布局 | 相同布局（地址不变） |

## 1. 目标芯片与内存

### 目标配置

- `firmware/CMakeLists.txt` 固定 `set(IDF_TARGET "esp32c6")`，不依赖 `idf.py set-target`。
- `sdkconfig.defaults` 固定 160 MHz、16 MB Flash、自定义分区表、USB Serial/JTAG 控制台。
- 已移除全部 `CONFIG_SPIRAM*` 选项；`firmware_s3/sdkconfig.defaults` 中的 `CONFIG_SPIRAM=y`、`CONFIG_SPIRAM_MODE_OCT=y`、`CONFIG_SPIRAM_SPEED_80M=y`、`CONFIG_SPIRAM_MALLOC_RESERVE_INTERNAL=65536` 不再存在。

### 内存分配调整

| 项目 | S3 | C6 | 说明 |
| --- | --- | --- | --- |
| 语音 PCM 环形缓冲 | `BUFFER_BYTES = 128000` | `BUFFER_BYTES = 48000` | `voice_init()` 用 `heap_caps_malloc(MALLOC_CAP_INTERNAL)` 分配，约 1.5 秒 16 kHz 单声道 |
| LVGL 绘制缓冲 | BSP 配置 `BSP_DISPLAY_LVGL_BUF_HEIGHT=10`（PSRAM） | 40 行 × 480 × 2 ≈ 38 KB，单缓冲 | `lvgl_bsp.cpp` 中 `disp_cfg.profile.buffer_height = 40` |
| LVGL 堆 | 由 BSP/配置决定 | 32 KB（`CONFIG_LV_MEM_SIZE=32768`） | 内部 RAM |
| LVGL 任务 | `esp_lvgl_port` | 16 KB 栈、优先级 8、core 0 | `stack_in_psram = false` |
| 任务栈 | 部分在 PSRAM | 全部内部 RAM：`main` 8 KB、`mic_capture` 8 KB、`voice` 6 KB、`air_mouse` 4 KB、`usb_config` 4 KB、HTTPS 12 KB | 单核下任务优先级更敏感 |

单核带来的直接约束：

- LVGL 任务优先级 8、鼠标采样任务优先级 7、录音任务优先级 7、语音任务优先级 5；录音和界面刷新同时进行时要观察是否丢帧或鼠标报点抖动。
- Wi-Fi 与 BLE 共用同一颗 C6；语音会话期间 BLE 仍保持连接，但两种模式在 UI 上互斥。
- 任何新增缓冲都应显式使用内部 RAM，并优先复用现有缓冲，而不是扩大流缓冲。

## 2. 板级 BSP

原 S3 工程依赖 Waveshare 托管组件 `waveshare/esp32_s3_touch_amoled_1_8: 2.0.3`。C6 板在复位方式、触摸芯片、音频通道上与 S3 不同，因此把板级代码 Vendor 到 `firmware/components/`：

| 组件 | 职责 |
| --- | --- |
| `bsp_port` | `I2cMasterBus`、`DisplayPort`（SH8601 QSPI + CST9217）、`CodecPort`（ES8311/ES7210）、`power_bsp`（AXP2101 + XPowersLib） |
| `bsp_app` | `esp_lv_adapter` 初始化、显示与触摸注册、LVGL 锁 |
| `board` | 用 C++ 实现、向 `main/` 暴露纯 C 接口，隔离上层与 C++ 组件 |
| `codec_board` | Espressif 的 ES8311/ES7210 初始化组件（Vendor 化），`board_cfg.txt` 增加 `C6_AMOLED_2_16` 条目 |

`firmware/components/board/include/board.h` 提供：

| 接口 | 说明 |
| --- | --- |
| `board_init()` | I2C → AXP2101 → 显示/触摸 → LVGL 适配器 → 音频 codec |
| `board_display()` | 返回 LVGL 默认显示 |
| `board_lock()` / `board_unlock()` | LVGL 适配器锁 |
| `board_i2c_bus()` | 共享 I2C 总线，供 QMI8658 使用 |
| `board_set_brightness()` | SH8601 `0x51` 命令，0–100 |
| `board_battery_connected()` / `board_battery_percent()` | AXP2101 电池状态，未接电池返回 -1 |
| `board_microphone()` | 16 kHz 立体声录音句柄 |

初始化顺序不能交换：AXP2101 必须先于显示，因为面板电源由 ALDO3 控制，显示驱动初始化时会用 ALDO3 断电复位。

## 3. 显示：368×448 → 480×480

- 驱动：SH8601，QSPI 4 线，SPI2_HOST，40 MHz，16 bit/像素，`quad_mode = true`。
- 初始化命令见 `components/bsp_port/display_bsp.cpp`，包含 `0x11`（Sleep Out，600 ms 延时）、`0x3A=0x55`（16 bit）、`0x53=0x20`、`0x51=0xFF`、`0x29`（Display On）等。
- **无独立复位脚**：`panel_config.reset_gpio_num = GPIO_NUM_NC`；`DisplayPort_DispReset()` 通过 AXP2101 `ALDO3` 执行「开 100 ms → 关 100 ms → 开 100 ms」完成面板复位。
- 亮度：`Set_Backlight()` 把 0–100 映射为 0–255 写入 `0x51`；UI 在活动时为 70、空闲 25 秒后为 24。
- 屏幕坐标按 480×480 重排，`app_main.c` 使用绝对坐标：

| 元素 | 坐标/尺寸 |
| --- | --- |
| 标题 | `(24, 27)` |
| BLE 状态 | `(25, 69)` |
| 电量（右上对齐） | `(-25, 69)` |
| Voice / Gyro | `(42, 112)` / `(288, 112)`，均 150×112 |
| A / B | `(42, 252)` / `(288, 252)`，均 150×112 |
| 状态文字 | 顶部居中 `y=404`，宽 420，自动换行 |

两列按钮之间留 96 px，适配 480 px 宽度；修改布局时同步调整这些常量。

## 4. 触摸：CST816S → CST9217

- CST9217 挂在共享 I2C 上：SCL=GPIO7、SDA=GPIO8、RST=GPIO11、INT=GPIO5、地址 `0x5A`，I2C 速率 400 kHz。
- 触摸配置（`display_bsp.cpp`）：`swap_xy = 1`、`mirror_x = 0`、`mirror_y = 1`，`x_max = y_max = 480`。
- 面板复位由 AXP2101 ALDO3 完成，触摸复位仍用 GPIO11。
- 已知易错点：微雪上游示例的 `user_config.h` 中 LCD CS 与触摸 INT 的数值曾出现 5/15 互换；本工程按实际可用配置使用 **LCD CS=GPIO15、触摸 INT=GPIO5**。若自行对照上游代码，先确认这一点。

触摸方向是首批需要上板确认的项：`swap_xy`/`mirror_y` 的取值来自 C6 板级移植，尚未在实物上点按验证。

## 5. 麦克风：单声道 → ES7210 TDM 立体声

- S3 BSP 直接输出 16 kHz 单声道；C6 的 ES7210 以 **I2S TDM、16 kHz、双声道、16 bit** 工作（`codec_bsp.cpp` 中 `in_mode/out_mode = CODEC_I2S_MODE_TDM`、`channel = 2`）。
- `voice.c` 的采集任务每次读取 1280 字节（20 ms 立体声），按左右声道两两求平均，下混为 640 字节单声道后写入环形缓冲，再按原协议发送。协议格式未变。
- 麦克风增益通过 `esp_codec_dev_set_in_gain(microphone, 25)` 设置；`board_cfg.txt` 的 `C6_AMOLED_2_16` 条目给出 I2S 引脚与 ES8311/ES7210 配置。
- 扬声器通路会随 codec 一起打开（`ES8311`），但当前固件没有播放提示音；若扬声器打开失败只记录告警，不阻塞录音。

风险在于 TDM 通道顺序：如果实际有效麦克风在右声道、或两声道内容不同，简单平均会降低音量甚至相互抵消。上板时先用串口/录音数据确认两声道波形，再决定取单声道还是加权下混。

## 6. 蓝牙：Bluedroid BLE 4.2 特性集

- `sdkconfig.defaults` 固定：

```ini
CONFIG_BT_ENABLED=y
CONFIG_BT_BLUEDROID_ENABLED=y
CONFIG_BT_BLE_ENABLED=y
CONFIG_BT_BLE_42_FEATURES_SUPPORTED=y
CONFIG_BT_BLE_50_FEATURES_SUPPORTED=n
```

- `ble_mouse.c` 使用 Bluedroid 的 **legacy advertising** API（`esp_ble_gap_config_adv_data` + `esp_ble_gap_start_advertising`），不使用 BLE 5.0 扩展广播。
- HID 设备名 `Codex Air Remote`，VID/PID `0x02E5/0xA180`，HID 服务 UUID `0x1812`，扫描响应携带设备名。
- 配对使用 LE Secure Connections + bonding，IO capability `NoInputNoOutput`；断开后重新广播，重连后由 `ble_mouse_generation()` 通知鼠标任务复位按键与位移。
- BLE 关闭 5.0 后代码不再引用扩展广播结构，迁移时不要打开 `CONFIG_BT_BLE_50_FEATURES_SUPPORTED`，否则需要同步改写广播代码。
- **必须显式注册 GATTS 回调**：`esp_hid` 的 BLE 传输层不会调用 `esp_ble_gatts_register_callback()`，官方 `esp_hid_device` 示例在应用层注册
  （`esp_ble_gatts_register_callback(esp_hidd_gatts_event_handler)`）。缺少这一步时 GATTS 建表事件全部丢失，`ESP_HIDD_START_EVENT`
  永不触发，板子不会广播；2026-11-09 前的 C6 构建即因此无法被 Windows 发现（现象：`AR1 READY 7` 正常但蓝牙搜不到，启动日志没有 `BLE HID started`）。
- 正常启动日志：`BLE HID started` → `BLE advertising started`；配对/连接/断开：`BLE pairing complete`、`BLE host connected`、
  `BLE host disconnected`。另有 1 s 兜底定时器，START 事件丢失时会打印 `HID start event missing, advertising anyway` 并强制广播。

## 7. 构建系统

| 项目 | C6 实现 |
| --- | --- |
| 目标芯片 | `CMakeLists.txt` 中 `set(IDF_TARGET "esp32c6")` |
| IDF 版本 | 5.5.5（`idf_component.yml` 要求 `>=5.5`） |
| Flash | `CONFIG_ESPTOOLPY_FLASHSIZE_16MB=y`，`dio`/80 MHz 由 `flash.py` 指定 |
| 分区 | `CONFIG_PARTITION_TABLE_CUSTOM=y`，`partitions.csv` 与 S3 布局相同 |
| 控制台 | `CONFIG_ESP_CONSOLE_USB_SERIAL_JTAG=y`（板上唯一的 USB 口） |
| 托管组件 | `idf_component.yml` 声明，首次构建下载，`dependencies.lock` 锁定 |
| 内嵌材料 | `main/CMakeLists.txt` 用 `target_add_binary_data` 嵌入 `windows/.local/server.crt`、`server.key`、`pairing.txt` |
| 发布清单 | `Build.ps1` 读取 `build/flasher_args.json` 生成 `build/airremote-release.json` |
| 辅助脚本 | `Idf.ps1` 负责 menuconfig / monitor / fullclean；`Build.ps1` 内部直接调用 `idf.py build` |

固件构建依赖 Windows 侧先完成 `Setup-Dev.ps1`（或至少由 `Build.ps1` 调用 `init_pairing.py` 生成配对材料）。换机器后 `.local` 变化，必须同时重编两侧。

## 8. Windows 侧配套改动

`windows/host/flash.py` 已按 C6 调整：

| 项目 | 改动 |
| --- | --- |
| 芯片 | esptool 参数 `--chip esp32c6` |
| 镜像目录 | `IMAGES = ROOT.parent / "firmware" / "build"`（仓库重构后路径） |
| 设备标识 | 错误文案与注释改为 ESP32-C6 |
| USB 识别 | 仍为 `VID:PID = 303A:1001`（C6 与 S3 相同） |
| 镜像地址 | 仍为 bootloader `0x0`、分区表 `0x8000`、otadata `0x10d000`、应用 `0x200000` |
| 校验 | 仍要求清单恰好包含四个地址，并逐个比对 SHA-256 |
| 配网 | 仍通过 USB Serial/JTAG 发送 `AR1?` / `AR1W`，要求 `AR1 READY 7 <12 位 MAC>` |

`flash.py` 对清单做集合相等检查：如果 `idf.py` 生成的 `flash_files` 多出或少掉镜像（例如启用 OTA 或安全启动），会报 `Unexpected image layout` 并停止。修改分区表时，必须同时更新 `partitions.csv`、`flash.py` 中的期望地址和本文档。

## 板级引脚表

| 功能 | 信号 | GPIO | 说明 |
| --- | --- | --- | --- |
| I2C | SCL | 7 | 触摸、PMU、IMU 共用 |
| I2C | SDA | 8 | 同上 |
| 显示 | CS | 15 | QSPI 片选 |
| 显示 | PCLK | 0 | QSPI 时钟 |
| 显示 | D0 | 1 | QSPI 数据 0 |
| 显示 | D1 | 2 | QSPI 数据 1 |
| 显示 | D2 | 3 | QSPI 数据 2 |
| 显示 | D3 | 4 | QSPI 数据 3 |
| 显示 | RST | — | 无独立复位，靠 AXP2101 ALDO3 断电 |
| 显示 | 背光 | — | 无 GPIO，亮度用 SH8601 `0x51` 命令 |
| 触摸 | INT | 5 | 中断输入 |
| 触摸 | RST | 11 | 触摸复位输出 |
| 触摸 | 地址 | — | I2C `0x5A` |
| PMU | I2C 地址 | — | AXP2101 `0x34`；ALDO3 供面板 |
| 音频 | MCLK | 19 | I2S TDM |
| 音频 | BCLK | 20 | I2S TDM 位时钟 |
| 音频 | WS | 22 | I2S TDM 帧时钟 |
| 音频 | DIN | 21 | ES7210 麦克风数据输入 |
| 音频 | DOUT | 23 | ES8311 扬声器数据输出 |
| IMU | I2C | — | QMI8658，地址由驱动探测高/低两档 |
| USB | D-/D+ | — | 芯片内置 USB-Serial/JTAG PHY，VID:PID `303A:1001` |
| 电池 | — | — | AXP2101 电量检测与充电配置 |

## 与 `flash.py` 的镜像地址约定

`firmware/build/airremote-release.json` 必须恰好包含以下四个键，值与 `firmware/build/` 下的文件对应：

| Manifest 键 | 文件 | 烧录地址 | 说明 |
| --- | --- | --- | --- |
| `0x0` | `bootloader/bootloader.bin` | `0x0` | 二级引导 |
| `0x8000` | `partition_table/partition-table.bin` | `0x8000` | 分区表 |
| `0x10d000` | `ota_data_initial.bin` | `0x10d000` | OTA 选择初始数据 |
| `0x200000` | `codex_air_remote.bin` | `0x200000` | 应用，分区大小 8 MB |

示例结构：

```json
{
  "0x0": { "path": "bootloader/bootloader.bin", "sha256": "…" },
  "0x8000": { "path": "partition_table/partition-table.bin", "sha256": "…" },
  "0x10d000": { "path": "ota_data_initial.bin", "sha256": "…" },
  "0x200000": { "path": "codex_air_remote.bin", "sha256": "…" }
}
```

约束：

- 烧录参数固定为 `--flash-mode dio --flash-size 16MB --flash-freq 80m`、波特率 921600；改 Flash 模式要同时改固件配置和 `flash.py`。
- 应用分区 8 MB 是硬上限；当前固件远小于该值，但开启大量字体/图片资源时需检查镜像大小。
- `otadata` 的 `0x10d000` 与应用 `0x200000` 之间还有 `phy_init` 和 `model` 分区，不能随意压缩。
- 改动分区表后，旧的 16 MB 原始备份仍可用于恢复，但新固件必须整片重烧，不能只写应用。

## 尚未实机验证的风险点

| 风险 | 现状 | 上板验证方法 | 可能需要调整 |
| --- | --- | --- | --- |
| 触摸方向/坐标 | `swap_xy=1`、`mirror_x=0`、`mirror_y=1` 来自移植配置，未实测 | 依次点四个按钮，确认坐标与图标一致、无镜像/旋转 | 调整 `display_bsp.cpp` 中三个 flag 或 `x_max/y_max` |
| 麦克风通道 | ES7210 TDM 双声道，`voice.c` 直接 `(L+R)/2` 下混，未确认有效通道 | 录音后检查音量与波形；分别试单取左/右声道 | 取单声道、交换声道或加权；必要时调 `esp_codec_dev_set_in_gain` |
| 亮度命令 | 通过 QSPI 面板 IO 写 SH8601 `0x51`，未确认该面板响应 | 观察 70/24 两档亮度是否变化、是否闪烁 | 改用初始化命令中的亮度寄存器、`0x53` 或固定亮度 |
| 无 PSRAM 内存余量 | 48 KB 流缓冲 + 38 KB 绘制缓冲 + 32 KB LVGL 堆 + 栈全部在内部 RAM | 启动日志看空闲堆；连续录音 60 秒、同时操作界面；记录最低余量 | 降低缓冲/字体/栈；减少同时驻留的组件 |
| 显示复位时序 | 依赖 AXP2101 ALDO3 三次 100 ms 切换 | 冷启动、复位后观察是否稳定点亮 | 调整延时或复位顺序 |
| 单核实时性 | 录音（优先级 7）、LVGL（8）、鼠标（7）与 Wi-Fi/BLE 共存 | 语音录音时观察 UI 是否卡顿、鼠标是否断报 | 调整任务优先级、降低刷新率 |
| BLE 重连与配对 | 根因（缺 GATTS 回调注册导致从不广播）已于 2026-11-09 修复；断开重连、删除设备后重配仍待实测 | 启动日志出现 `BLE HID started`/`BLE advertising started`；Windows 能搜到并配对；断开/重连、重启 Windows 蓝牙、删除设备后重配 | 调整安全参数/广播间隔 |
| 语音 PULL 延迟 | 会话期间 `esp_wifi_set_ps(WIFI_PS_NONE)` 已代码修复（此前 modem sleep 的 DTIM 唤醒把 PULL 往返拖到 >300 ms，16 KB PCM 缓冲约 0.5 s 即溢出） | `e2e_test.py` 连续拉帧、无 `PCM buffer full`；串口出现多条 `ws msg 'PULL'`/`sent ... bytes` | 如仍不足，增大 `BUFFER_BYTES` 或每帧批大小 |
| USB 配网与日志复用 | 日志与 `AR1?`/`AR1W` 共用 USB Serial/JTAG | 烧录后立即发送 `AR1?`，确认不被日志淹没 | 必要时在配网窗口临时降低日志级别 |
| 电池与充电 | AXP2101 配置沿用板级参考值 | 插拔电池、观察电量与充电状态 | 调整充电电流/终止电压 |

## 上板验证清单

1. `firmware\Build.ps1` 构建成功，四个镜像的 SHA-256 与 `airremote-release.json` 一致。
2. `windows\Flash.cmd --check` 通过；完整烧录能完成备份、写入、配网和蓝牙配对。
3. 串口日志出现 `Flash ... bytes; internal heap ... bytes free` 与 `AIRREMOTE UI READY; IMU=1 BLE=1 VOICE=1 PMIC=?`。
4. 屏幕点亮、方向正确，四个按钮位置与触摸命中一致，电量显示合理。
5. BLE 能被 Windows 搜到并配对（启动日志有 `BLE HID started` + `BLE advertising started`）；Gyro 校准后光标可移动、静止不漂移，A/B 左右键与拖拽正常。
6. 热点模式与局域网模式各完成一次 Voice 录音，Codex 能收到文字；A 发送、B 取消、60 秒上限均生效；E2E 过程中无 `PCM buffer full`。
7. 连续录音/待机 10 分钟后检查空闲堆、是否重启、是否断流。
8. 亮度在活动与空闲两档可辨识，无闪烁。
9. 完整步骤与期望日志见 [pending-hardware-validation.md](pending-hardware-validation.md)。

## 相关文件

| 主题 | 文件 |
| --- | --- |
| 目标与内存 | `firmware/CMakeLists.txt`、`firmware/sdkconfig.defaults`、`firmware/main/voice.c`、`firmware/components/bsp_app/lvgl_bsp.cpp` |
| 板级与引脚 | `firmware/components/bsp_port/user_config.h`、`display_bsp.cpp`、`codec_bsp.cpp`、`power_bsp.cpp` |
| UI 与坐标 | `firmware/main/app_main.c` |
| 蓝牙 | `firmware/main/ble_mouse.c`、`firmware/main/air_mouse.c` |
| 分区与镜像 | `firmware/partitions.csv`、`firmware/Build.ps1`、`windows/host/flash.py` |
| 组件版本 | `firmware/main/idf_component.yml`、`firmware/dependencies.lock` |

## 参考资料

- [微雪 ESP32-C6-Touch-AMOLED-2.16 官方工程](https://github.com/waveshareteam/ESP32-C6-Touch-AMOLED-2.16)
- [ESP-IDF v5.5.5](https://github.com/espressif/esp-idf/releases/tag/v5.5.5)
- [ESP32-C6 技术参考手册](https://www.espressif.com/sites/default/files/documentation/esp32-c6_technical_reference_manual_en.pdf)
- [SH8601 驱动组件](https://components.espressif.com/components/espressif/esp_lcd_sh8601)
- [CST9217 触摸组件](https://components.espressif.com/components/waveshare/esp_lcd_touch_cst9217)
- [esp_lvgl_adapter](https://components.espressif.com/components/espressif/esp_lvgl_adapter)
- [esp_codec_dev](https://components.espressif.com/components/espressif/esp_codec_dev)
