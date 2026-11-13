# 固件审计报告（对照官方 + 社区同板实现）

> 轮次：2026-11-09 代码审计轮（不连板、不烧录、不占串口、不动热点）。
> 结论：**Go（可交给用户实测）**，但必须按 [`pending-hardware-validation.md`](pending-hardware-validation.md)
> 的顺序执行，首项就是显示/引脚 A/B 变体确认。

## 1. 审计方法与来源

| 来源 | 版本/提交 | 用途 |
| --- | --- | --- |
| 本机出厂固件备份 `windows/.local/backups/84c7bbfffe3d-before-air-remote.bin` | 2026-11-08 整片备份，SHA-256 校验通过 | 抓启动日志确认实际驱动/初始化（`sh8601 v2.0.1`、`esp32_c6_touch_amoled_2.16` BSP、`Backlight on`） |
| `waveshareteam/ESP32-C6-Touch-AMOLED-2.16` `02_Example/ESP-IDF-v5.5.3/09_LVGL_V9_Test` | main 分支 | port_bsp 参考（display_bsp.cpp/lvgl_bsp.cpp/main.cpp/user_config.h） |
| `waveshare/esp32_c6_touch_amoled_2_06`（组件注册表 v2.0.0） | 同 MCU、同 SH8601 驱动 | 官方 C6 BSP 的显示/触摸/亮度实现 |
| `waveshare/esp32_s3_touch_amoled_2_16`（组件注册表 v2.0.1） | 同 2.16 面板、不同 MCU | 面板 init/窗口参数交叉验证（该板用 CO5300，仅窗口参数可参考） |
| `mfellner/esp32-playground` `components/board/board.cpp` + `docs/hardware.md` | main 分支 | **同板可运行实现**（显示/触摸/PMU/亮度/IMU） |
| `Keung123/ESP32-Codex-Sidekick` | main 分支 | 同板 Codex 用途参考；仓库内 `firmware/` 只有 README（无源码），未采用 |

审计手段：逐行对照源码、抓取出厂固件启动日志、组件注册表版本核对、编译 + 静态检查。

## 2. 逐项对照与结论

### 2.1 显示 / 电源 / 触摸（重点，历史黑屏问题）

| 项目 | 官方/社区证据 | 我们旧实现 | 结论/修复 |
| --- | --- | --- | --- |
| LCD CS / 触摸 INT | mfellner `board.cpp`：`cs=15`、`touch int=5`；09 示例 `display_bsp.h` 默认 `cs=15, tp_int=5`；官方 C6 2.06 BSP 头文件却是 5/15；其 `user_config.h` 的 5/15 未被示例 main 引用 | 出过 15/5 与 5/15 两版（临时改动） | **采用 15/5 为默认（两来源一致）**；`components/bsp_board/include/board_pins.h` 集中定义，可用 `CONFIG_BOARD_LCD_PINS_VARIANT_B=y` 切到 5/15 做 A/B 验证 |
| QSPI 参数 | 同板实现：`pclk=40MHz`、`lcd_cmd_bits=32`、`param_bits=8`、`quad_mode=true`、`trans_queue_depth=1`、`max_transfer_sz≈width*24*2` | 相同（queue=1） | 一致，保留 |
| 面板 init 序列 | 同板实现与 09 示例完全一致：0x11(600ms)、0xFE/0x19/0x1C/0xFE、0xC4、0x3A、0x35、0x36、0x53、0x51=0xFF、0x63、0x2A/0x2B={0,0,1,0xDF}、0x29(100ms) | 相同 | 一致，保留；`0x3A/0x36` 被 SH8601 驱动内部覆盖的 warning 属正常 |
| reset / disp_on | 同板实现：`panel.reset_gpio_num=-1`，仅 `esp_lcd_panel_init()`（init 表内已含 0x29）；官方 C6 2.06 BSP 额外显式 `disp_on_off(true)` | 仅 `esp_lcd_panel_init()` | 保留 init 表 0x29 路线（与同板实现一致），不再加 disp_on（避免两次 0x29） |
| ALDO3（面板复位轨） | **同板实现只写 AXP2101 0x94 的电压值（(v&0xE0)|28 → 3.3V），然后 enable→disable→enable（各 100ms）**；明确注明“不改充电与其它无关轨道” | `Custom_PmicRegisterInit()` 额外写 VBUS 限流、DC1/ALDO1/2/4 电压、充电电流 | **已改为同板最小实现**：只设置 0x94 并三次 toggle ALDO3；充电/其它轨道保持出厂值 |
| 背光/亮度 | 同板实现亮度 = 100% 映射到 SH8601 0x51（255）；出厂日志 `Backlight on` 即 BSP 的 `bsp_display_backlight_on()` → `bsp_display_brightness_set(100)`，最终也是 0x51 | `Set_Backlight` 同样 0x51 编码 | 一致；init 表已含 0x51=0xFF |
| 触摸 | 同板：CST9217 I2C 0x5A、RST=11、INT=5、`swap_xy=1`、`mirror_y=1` | 相同 | 一致；INT 引脚随 A/B 变体切换 |
| LVGL 注册 | 同板：`esp_lv_adapter` + stack 20KB + buffer_height 12 + 单缓冲 | stack 8KB、buffer 8 | **已对齐为 stack 20KB / buffer 12 / 单缓冲**（更接近已验证配置；待实测确认内存余量） |
| 引脚集中管理 | — | 分散在 user_config.h | 新增 `board_pins.h` 单点定义 + `user_config.h` 映射层 |

### 2.2 音频（ES8311/ES7210 + I2S TDM）

| 项目 | 对照 | 结论 |
| --- | --- | --- |
| I2S TDM 参数 | 出厂日志：`mclk19/bclk20/ws22/din21/dout23`、`CODEC_INIT ... type: 3`（TDM）、16kHz stereo、`ES8311 slave`、`ES7210 slave` + 4 路 MIC 使能 | 我们 `codec_bsp.cpp` 使用相同引脚/TDM/16k stereo，`esp_codec_dev` 用法一致 |
| 麦克风增益 | 同板参考未固定增益 | 我们保留 `esp_codec_dev_set_in_gain(25)`（待实测音质） |
| 失败处理 | — | `init_codec` 失败不再 `ESP_ERROR_CHECK` 重启，改为记录日志并让音频功能降级（不阻塞显示/语音之外的启动） |

### 2.3 PMU / 电池 / 充电

| 项目 | 结论 |
| --- | --- |
| AXP2101 地址/初始化 | 0x34、100kHz，与出厂一致 |
| 轨道 | 改为只动 ALDO3（面板复位轨），避免副作用 |
| 电池 | 仍通过 XPowersLib 读 `isBatteryConnect`/`getBatteryPercent`；`isChargingTask` 保留（20s 周期日志） |
| 充电配置 | 不再在启动时改写预充/恒流/终止电流（保持出厂） |

### 2.4 IMU / 鼠标 / BLE HID

| 项目 | 结论 |
| --- | --- |
| QMI8658 | 地址 0x6B，与出厂日志一致；量程/ODR/校准/轴向沿用既有实现（待实测手感确认） |
| GATTS 回调注册 | **已保留根因修复**：`esp_ble_gatts_register_callback(esp_hidd_gatts_event_handler)`（esp_hid BLE 传输层不注册，不注册则永不广播） |
| CCC/通知就绪 | 保留 `reports_ready` 探测（500ms 退避 + 限频 WARN + 库日志静音），未就绪时丢弃位移/不重试 |
| 按键对账 | 保留 ~2s 状态对账 + release 重试 500ms 退避 |
| release/resume 竞态 | 保留 `releasing/linked` 先置位、250ms 等待 `report_lock`、超时拒绝 deinit（避免 UAF） |

### 2.5 语音 / 网络

| 项目 | 结论 |
| --- | --- |
| TLS 1.2 + WSS | 保留（PC 侧强制 TLS1.2；mbedTLS 内存配置见 sdkconfig） |
| 单播发现 | 保留板端 `AR1A`+MAC 单播公告 + PC 0.0.0.0:47682 监听 |
| WIFI_PS_NONE | 保留（会话开始后关闭 modem sleep） |
| 内存 | `CONFIG_MBEDTLS_SSL_IN_CONTENT_LEN=1024`、`OUT=2048`、关闭硬件 AES（省 DMA） |
| 异常路径 | AUTH 拒绝/ABORT/超时日志保留；`request->free_ctx=free` |

### 2.6 工程 / 构建

| 项目 | 结论 |
| --- | --- |
| 组件版本 | `esp_lcd_sh8601 ^2.0.1`（与出厂 v2.0.1 一致）、`esp_lvgl_adapter ~0.3.0`、`waveshare/esp_lcd_touch_cst9217 ^1.0.4`、`lvgl ^9.5.0` |
| 目录布局 | 已按官方：`main/` 仅入口，`components/{bsp_board,app_ui?,app_mouse,app_voice,app_provision}` |
| 临时探针 | 已删除（panel_probe、AR1D/AR1B/AR1R/AR1W/AR1T/AR1X、board_display_fill/diag/reinit）；`AR1V` 串口语音触发当时保留（固件 0.7.1 起已移除） |
| 编译 | 本机 IDF 与 `env/` 内 IDF 均可编译通过（见验收记录） |

## 3. 已修复问题清单

| # | 严重度 | 问题 | 修复 |
| --- | --- | --- | --- |
| 1 | 高 | 显示初始化沿用了“通用 Waveshare 示例”的 PMU 全量寄存器改写（DC1/ALDO1/2/4/VBUS），与同板已验证实现不符，是黑屏首要嫌疑 | 改为同板最小实现（只写 0x94 + ALDO3 三次 toggle） |
| 2 | 高 | 引脚被临时改为 5/15 且散落；来源冲突无回退方案 | 新增 `board_pins.h`，默认 15/5，Kconfig 变体可切 B（5/15） |
| 3 | 中 | `board_microphone()` 在组件拆分时被误删 | 已恢复 |
| 4 | 中 | LVGL 任务栈/绘制缓冲小于同板已验证值 | 对齐为 20KB stack / buffer 12 |
| 5 | 中 | 工程结构把全部应用代码堆在 `main/` | 拆分为 `app_mouse/app_voice/app_provision`（UI 仍待迁入 `app_ui`，见遗留） |
| 6 | 低 | 临时诊断代码散落 | 已删除（此前保留的 AR1V 串口语音触发已于固件 0.7.1 移除） |
| 7 | 低 | `provision.c` 与 `voice.c` 相互包含造成组件环依赖 | 改为本地 extern 声明打破环 |

## 4. 遗留风险（无法静态 100% 确认，需实测）

1. **引脚 A/B**：CS 15 vs 5、触摸 INT 5 vs 15 两套来源冲突；默认 A（15/5），若实测黑屏，切 `CONFIG_BOARD_LCD_PINS_VARIANT_B=y` 重烧即可验证 B。
2. **显示点亮**：同板实现与 init 序列一致，但本项目历史上有过黑屏；需实测确认（见待实测清单第 1 项）。
3. **语音 E2E**：TLS/WS/单播发现与 Wi-Fi 省电策略为代码级修复，未实机回归。
4. **BLE HID CCC**：Windows 曾出现不订阅通知（GATTS 探针证实无 CCC 写入）；本版保留 500ms 探测与退避，实机需确认光标/按键。
5. **音频通道/增益**：ES7210 双麦取通道方式未实测。
6. **内存余量**：LVGL 栈 20KB + BLE + 语音缓冲后的最小堆需实测记录。
7. **UI 组件化**：本轮把 UI 留在 `main/app_main.c`（其余功能已拆组件），后续可继续迁移 `app_ui`（不影响功能）。

## 5. Go / No-Go

**Go**：所有已确认的代码级问题均已修复，工程可编译，临时探针已清理；剩余风险均为“必须实机才能确认”的项，已按风险排序写入
[`pending-hardware-validation.md`](pending-hardware-validation.md)。

No-Go 条件（任一满足则回到代码轮）：实测显示仍黑（先切引脚 B 再判定）、或出现 panic/看门狗、或 BLE 连接后 HID 通知仍无法使能。

## 附录 A：与同板已验证实现的逐行差异（显示/电源）

参考：`mfellner/esp32-playground` `components/board/board.cpp`（同板 ESP32-C6-Touch-AMOLED-2.16，
`docs/hardware.md` 记录其已在实机运行）+ 官方 `waveshare/esp32_c6_touch_amoled_2_06` BSP。

| 项目 | 参考实现 | 我们的实现（bsp_board） | 判定 |
| --- | --- | --- | --- |
| I2C | `i2c_port=0`、SDA=8、SCL=7、`glitch_ignore_cnt=7`、`enable_internal_pullup=true` | I2cMasterBus(SCL=7, SDA=8, port0)，由 ESP-IDF 总线驱动处理内部上拉/glitch | 等价（总线工作正常，PMU 可读） |
| PMU 初始化 | 建 PMU I2C dev（0x34）；**只写 0x94 电压、ALDO3 三次 toggle**；显式配置电源键；注明“不改充电/无关轨道” | 同样建 PMU dev；`Custom_PmicRegisterInit()` 改为仅写 0x94 + enable/disable/enable；未复制电源键配置（非必需） | 已对齐（本轮修复） |
| LCD CS | 15 | 15（`board_pins.h` 变体 A 默认） | 一致 |
| 触摸 INT / RST | 5 / 11 | 5 / 11（变体 A） | 一致 |
| QSPI bus | sclk0、d0..3=1..4、`max_transfer_sz=480*24*2` | 同引脚，`max_transfer_sz=480*50*2`（更大，仅影响单个传输上限） | 等价 |
| panel IO | `cs=15, dc=-1, mode0, 40MHz, queue=1, cmd_bits=32, param_bits=8, quad=true` | 完全相同（display_bsp.cpp 手工构造） | 一致 |
| panel 配置 | `reset_gpio=-1, RGB order, bpp16` | 相同 | 一致 |
| 初始化调用顺序 | `new panel` → `esp_lcd_panel_init()`（无显式 reset/disp_on；0x29 在 init 表内）→ touch → LVGL | `new panel` → `DisplayPort_DispReset()`（ALDO3 三次 toggle）→ `esp_lcd_panel_init()` → touch → LVGL | 等价（ALDO3 toggle 位置不同，均为上电复位语义） |
| init 序列 | 0x11(600)、0xFE/0x19/0x1C/0xFE、0xC4、0x3A、0x35、0x36、0x53、0x51=0xFF、0x63、0x2A/0x2B={0,0,1,0xDF}、0x29(100) | 逐字节相同 | 一致 |
| 亮度 | 0x51 = n*255/100（60%） | 0x51 = n*255/100（70% 活动、24% 空闲） | 等价（仅策略不同） |
| 触摸配置 | x/y=480、RST=11、INT=5、`swap_xy=1`、`mirror_y=1` | 相同 | 一致 |
| LVGL | esp_lv_adapter：stack 20KB、buffer_height 12、单缓冲、`LV_ROTATE_0`、rounder 对齐偶像素 | 已对齐（20KB/12/单缓冲 + 同样的 rounder 回调） | 一致 |
| 电源键/自动旋转/电池 app 逻辑 | 参考实现有 PWR 键与自动旋转 | 我们未实现（不在本产品需求内） | 有意差异 |

> 结论：显示与电源初始化已与本项目“同板可用实现”逐项对齐；历史黑屏最可能来自旧版 `Custom_PmicRegisterInit()`
> 对无关 PMU 寄存器的改写，本轮已移除。

## 附录 B：env/ 内构建状态（本轮未闭环）

- 已修：`env/activate.ps1` 增加 `ESP_ROM_ELF_DIR`（指向 `env/tools/esp-rom-elfs/20241011`）、补齐 toolchain/IDF/tools 到 PATH。
- 仍阻塞：cmake 报 “C compiler identification is unknown”（riscv32-esp-elf-gcc 可执行文件存在但 cmake 编译器识别失败），
  `idf_tools.py export` 报 `xtensa-esp-elf-gdb has no installed versions`——判断是 **env/tools 缺少 idf_tools 的安装元数据**
  （原 EIM 安装的 `C:\Espressif` 下无 tools.json，元数据由 EIM 注册表维护），需要下一轮：
  1. 在 env 内跑 `idf_tools.py install --targets esp32c6`（网络可用时）生成元数据；
  2. 或把 EIM 的整目录（`C:\Espressif` 含 dist/）一并复制并用 `activate.ps1` 复现其 export 环境；
  3. 通过后执行 `idf.py -C firmware build` 并把日志保存为 `firmware/build/env-build.log`。
- 本机 IDF 5.5.5 构建已绿（`Project build complete`，bin 2,320,016 bytes）。

### 附录 B 更新（2026-11-09 最终修复）

`env/` 构建已修通，根因是 **IDF_TOOLS_PATH 必须指向含 `tools/`、`dist/`、`espidf.constraints.v5.5.txt` 的 EIM 安装根**（不是只含工具子目录），且 `activate.ps1` 必须：

1. 先把 env 的 python 加入 PATH（`env/espressif/tools/python/v5.5.5/venv/Scripts`）；
2. dot-source `$IDF_PATH/export.ps1`（官方导出流程会生成完整工具链 PATH 与 `ESP_ROM_ELF_DIR`）；
3. dot-source 期间把 `$ErrorActionPreference` 临时设为 `Continue`（激活脚本会向 stderr 打进度，PS5 会当终止错误）。

修复后：
- `env/activate.ps1` 输出正确 `IDF_TOOLS_PATH = env/espressif/tools`、`ESP_ROM_ELF_DIR = env/espressif/tools/tools/esp-rom-elfs/20241011`；
- `idf.py -C firmware fullclean build` → **`Project build complete`，exit 0**，日志保存于 `firmware/build/env-build.log`；
- `firmware/build/codex_air_remote.bin` 生成。

## 6. UI 组件化（第 16 轮完成）

- `components/app_ui/`：拥有全部 LVGL 控件（状态栏、Gyro/Voice/A/B 按钮与提示）、125ms 渲染定时器、
  按钮事件（鼠标左/右键、语音发送/取消、模式切换）与亮度策略；对外接口：
  - `bool app_ui_init(lv_display_t *display)`：创建 UI 并注册渲染定时器；
  - `void app_ui_set_capabilities(bool mouse_ready, bool ble_ready, bool voice_ready)`：main 在初始化后上报能力位。
- `main/app_main.c`（现 91 行）：只做初始化编排（NVS/USB/语音缓冲/PMU/IMU/音频/显示/BLE/UI）与堆日志，
  调用 `app_ui_set_capabilities()` + `app_ui_init()`；状态采集仍由 UI 组件通过 `air_mouse.h`/`voice.h` 查询，行为不变。
- 临时 `lv_mem` 打印已从 UI 移除；触摸配置改为零初始化，消除自身 `-Wmissing-field-initializers` 警告。
