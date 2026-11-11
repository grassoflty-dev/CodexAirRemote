# 待实测清单（接板验收）

本文档是 2026-11-09「纯代码轮」的产出：本轮不允许实机操作（不烧录、不串口、不动热点/服务），因此把
必须接板才能确认的项目集中列在这里，供之后一次性执行。代码侧已按这些步骤做好的准备见
`firmware/README.md`、`docs/firmware-c6-migration.md`。

> **状态（2026-11-09）**：代码轮已完成并收尾——task-3（陀螺仪 + A/B 按键）已标记 completed（代码完成），
> task-2（语音链路收尾与最终交付）保持 in_progress；两者都**等待用户恢复实机测试**后按本清单执行。

> 每步都给出**命令**、**期望日志/观察点**。执行时建议把串口日志与 Windows 侧截图/日志一起留档，
> 直接填入本文件的「结果」列（或在 `firmware/build/` 下另存）。

## 0. 本轮已完成的代码改动（需要被实测确认）

| 改动 | 文件 | 需要实测确认的点 |
| --- | --- | --- |
| **BLE HID 根因修复**：注册 `esp_hidd_gatts_event_handler`（此前缺失，导致 GATTS 事件全部丢失、永不广播、Windows 搜不到设备） | `firmware/main/ble_mouse.c` | 启动日志出现 `BLE HID started` + `BLE advertising started`；Windows 能搜到并配对 |
| 广播兜底定时器（HID START 事件延迟/丢失时只打诊断错误，不伪造 HID 服务强行广播） | `firmware/main/ble_mouse.c` | 正常情况下不应出现 `HID start event missing, not advertising` |
| BLE release/resume 幂等、分阶段初始化/回滚、错误码记录 | `firmware/main/ble_mouse.c` | 连续多次语音会话后 BLE 仍能恢复；堆不持续下降；无 `BLE init failed` |
| **报告/释放并发安全**：`ble_mouse_report()` 互斥 + 短超时；`ble_mouse_release()` 先断 `linked` 再等 250 ms，报告卡死时拒绝 deinit 并让会话以 `NETWORK_ERROR` 中止（防 use-after-free） | `firmware/main/ble_mouse.c`、`firmware/main/voice.c` | 正常会话看不到 `HID report still in flight, keeping the BT stack up`；若出现，说明链路已半死、需重启板子 |
| 按键状态对账（每 ~2 s 若 `sent_buttons != requested_buttons` 重发状态，防卡键） | `firmware/main/air_mouse.c` | A/B 按下/释放、断连重连后不卡键 |
| 鼠标失败时真正 `mouse_stop()`（此前只清 UI 标志） | `firmware/main/app_main.c` | 校准失败后传感器/报告停止，重试可用 |
| 语音会话期间 `esp_wifi_set_ps(WIFI_PS_NONE)`（modem sleep 的 DTIM 唤醒延迟让 PULL→帧往返 >300 ms，会把 16 KB PCM 环缓冲冲爆） | `firmware/main/voice.c` | `e2e_test.py` 能持续拉到 PCM 帧，不再出现 `PCM buffer full` |
| 音频帧日志降频（每秒 1 行 + 失败必打，`PULL` 逐帧日志降 DEBUG），避免控制台反压 HTTP 服务 | `firmware/main/voice.c` | 会话期间串口 Log 稀疏；拉帧速率正常 |
| 单播 `AR1A` 发现（板端 → 网关 47682）+ PC 端 47682 监听 | `firmware/main/voice.c`、`windows/host/companion.py` | `e2e_test.py` 打印 `discovery reply: 41523141...`（AR1A+MAC） |
| AUTH/异常帧诊断日志 | `firmware/main/voice.c` | 异常时串口出现 `ws rejected (state=..., len=...)` |
| **语音目标切换（Codex/DSH）**：设置持久化 `voice_target`、companion 按目标路由、DSH 经 VB-CABLE 作为其麦克风、Codex 路径保留 | `windows/host/{voice_target.py,dsh_dictation.py,dsh_dictation.ps1,companion.py,setup_dialog.py}` | 目标切换后下一次语音会话生效；Codex 行为不回归；DSH 自动点击不可用时进入手动模式（见 5b 阶段） |

## 1. 前置条件

- Waveshare ESP32-C6-Touch-AMOLED-2.16，数据 USB-C 线，串口 `COM3`（VID:PID `303A:1001`）。
- ESP-IDF 5.5.5 已安装（`C:\Espressif-AirRemote\v5.5.5\esp-idf`，激活脚本 `C:\Espressif\tools\Microsoft.v5.5.5.PowerShell_profile.ps1`）。
- `windows\.venv` 存在；`windows\.local\{server.crt,server.key,pairing.txt}` 与待烧固件来自同一套材料。
- 关闭所有占用 `COM3` 的程序；**打开/关闭 COM3 会复位开发板**，脚本需先开串口等 ≥3 s 再发命令。
- 若用热点模式：Windows 移动热点由配对材料派生（当前 `AirRemote-2B04F2`），`Start` 后等 20–30 s 稳定，
  PC 侧网卡拿到 `192.168.137.1` 再继续。

## 2. 阶段 A：构建、烧录、启动

| 步骤 | 命令 | 期望 |
| --- | --- | --- |
| A1 构建 | `powershell -NoProfile -ExecutionPolicy Bypass -File .\firmware\Build.ps1` | 结束于 `Project build complete`；`firmware\build\airremote-release.json` 更新；`firmware\build\build.log` 无 `error:`/`warning:` |
| A2 完整性检查 | `windows\.venv\Scripts\python.exe -u windows\host\flash.py --check` | `All four firmware files match the release manifest.` + 热点能力 `Enabled`、2.4 GHz `True` |
| A3 完整烧录+配网 | `windows\Flash.cmd`（等价 `python -u windows\host\flash.py`） | 备份 16 MB → 写入校验 → 写 Wi-Fi → 启动服务 → 尝试蓝牙配对；无异常 |
| A3b 快速重烧（调试用） | `windows\.venv\Scripts\python.exe -u firmware\build\debug_flash_capture.py --flash` | `Hash of data verified.` 并抓 20 s 启动日志到 `firmware\build\boot-latest.txt` |
| A4 就绪查询 | 开 COM3 → 等 3 s → 发 `AR1?` | `AR1 READY 7 <12 位 MAC>` |
| A5 启动日志 | 看 A3b 的 `boot-latest.txt` | 见下 |

A5 期望日志（顺序大致如下，条目都要出现）：

```
I (xxx) air_remote: heap after boot           free=170048 ...
I (xxx) air_remote: heap after ui             free≈23–27 KB（GATTS 建表后比旧版本少几 KB）
I (xxx) air_remote: AIRREMOTE UI READY; IMU=1 BLE=1 VOICE=1 PMIC=1
I (xxx) air_mouse: QMI8658 at 0x6a, WHO_AM_I=0x05
I (xxx) ble_mouse: BLE HID started
I (xxx) ble_mouse: BLE advertising started
```

> 旧版本因缺少 GATTS 回调，HID 属性表从未创建，因此空闲堆看起来更大；修复后 `heap after ble`/`heap after ui`
> 会比历史日志少几 KB，属正常。若建表时内存不足，串口会出现 `esp_ble_gatts_create_attr_tab` / `BLE_HIDD`
> 相关错误，需要把 `heap after ui` 的余量记入问题记录。

> 若 **没有** `BLE HID started` / `BLE advertising started`，说明 GATTS 回调仍未生效（本轮根因修复
> 回退或 IDF 版本变化），Windows 一定搜不到设备；若出现 `HID start event missing, advertising anyway`
> 说明广播兜底生效，需在问题记录里标注。

## 3. 阶段 B：BLE 空中鼠标（task-3）

| 步骤 | 操作/命令 | 期望 |
| --- | --- | --- |
| B1 配对 | 板子空闲（不在语音会话）时：`powershell -NoProfile -ExecutionPolicy Bypass -File windows\host\pair-mouse.ps1 -Address <12 位 MAC>` | 返回 `Success` 或 `AlreadyPaired`；板端日志 `BLE pairing complete`、`BLE host connected` |
| B2 Windows 侧确认 | `Get-PnpDevice \| Where-Object { $_.InstanceId -match 'VID_02E5' }`；设置 → 蓝牙 → 设备 | 出现 `Codex Air Remote`；设备管理器鼠标设备正常（无黄色感叹号） |
| B3 进入 Gyro | 点屏幕 `Gyro` 按钮 | 状态文字 `Hold still to calibrate...`；1 s 内保持静止后变 `Mouse active` |
| B4 移动 | 保持 Gyro 模式，倾斜/转动板子 | 光标平滑移动；方向符合直觉（左右上下不反）；无卡顿、无跳变 |
| B5 静止漂移 | 把板子平放静止 10 s | 光标基本不动（允许 ≤1–2 px 的噪声）；不出现持续单向漂移 |
| B6 A/B 点击 | 鼠标模式下：按住 A = 左键按下，抬起 = 左键释放；B 同理右键；做一次拖拽 | 点击/拖拽生效；抬起后不残留按下状态（可用「画图」拖一条线验证） |
| B7 观察脚本（可选） | `windows\.venv\Scripts\python.exe -u firmware\build\mouse_probe.py --pair --seconds 75`，按提示操作板子 | 汇总 `moved samples > 0`、`path length > 0`、左右键 down/up 计数相等；无 `WARNING` 卡键提示；`mouse-probe.csv` 留档 |
| B8 断开重连 | Windows 蓝牙里断开再连（或关/开蓝牙） | 板端 `BLE host disconnected` → `BLE advertising started` → `BLE host connected`；按键与位移复位，不卡键 |
| B9 失败路径（可选） | 进入 Gyro 后 15 s 内持续晃板子 | 状态文字 `Calibration failed. Hold still and retry`，传感器停止；再点 Gyro 可重试 |

## 4. 阶段 C：按键 A / B（task-3）

| 场景 | 操作 | 期望 |
| --- | --- | --- |
| 鼠标模式 A | 按下 A 保持 2 s 再抬 | 左键按下 → 抬起；无重复点击/卡键 |
| 鼠标模式 B | 同上 | 右键按下 → 抬起 |
| 拖拽 | 按住 A 的同时移动板子 | 拖拽选中；抬手结束拖拽 |
| 语音模式 B（无 PC 也可） | 点 `Voice` → 屏幕显示 `Connecting to PC... B cancels` → 点 B | 立即变成 `Recording cancelled`（`VOICE_CANCELLED`） |
| 语音模式 A | 有 PC 服务时录音中点 A | 变成 `Finishing Codex dictation...`（`VOICE_RECORDING` → 发送语义） |
| 互斥 | 鼠标模式进行中看点 `Voice`；语音忙时点 `Gyro` | 对应按钮为禁用状态，无法进入另一模式 |
| UI 提示 | 鼠标模式 | A 按钮显示 `Left click`，B 显示 `Right click`；语音录音时 A `Send`、B `Cancel` |
| 状态复位 | 停止 Gyro 再进 Gyro | 重新校准；上一次的按键/位移不残留 |

## 5. 阶段 D：语音链路（task-2 剩余）

> `AR1V` 串口调试入口本轮**保留**（`firmware/main/provision.c`），后续实测继续用它无头触发语音会话；
> 最终交付前再决定是否删除。

| 步骤 | 命令 | 期望 |
| --- | --- | --- |
| D1 热点 | `powershell -NoProfile -ExecutionPolicy Bypass -File windows\host\hotspot.ps1 -Operation Inspect`（必要时 `Start`，start 的 stdin 需要 `{"ssid":"AirRemote-2B04F2","password":"<pairing 派生的 24 位口令>"}`） | `state=On`、`ssid=AirRemote-2B04F2`；PC 侧 `Get-NetIPAddress` 出现 `192.168.137.1` |
| D2 E2E | `windows\.venv\Scripts\python.exe -u firmware\build\e2e_test.py`（自动经 COM3 发 `AR1V` 并抓 75 s 日志） | PC：`discovery reply: 41523141<MAC>`（AR1A+MAC）→ `TLS + WebSocket OK` → `handshake: READY2` → `capture: GO` → 连续帧（前 5 帧打印 `bytes[644|1284] seq=N`）→ `audio: N frames, ... bytes` → `abort ack: ACK` |
| D3 板端日志 | `firmware\build\voice-e2e-board.txt` | `BT released` → `Wi-Fi got IP` → `TLS server up` → `discovery: announcing to 192.168.137.1:47682` → `ws handler`/`ws msg 'CAPTURE'` → 多条 `ws msg 'PULL'` + `sent ... bytes seq N` → `serve_voice result=12` → `BLE host resumed: ESP_OK` |
| D4 音频质量 | 听 PC 侧收到的 PCM（或看 `voice-e2e-board.txt` 中是否有 `PCM buffer full`） | 不应出现 `PCM buffer full`；连续录音 10 s 帧率稳定 |
| D5 真实 companion | 把 `windows\.local\companion-settings.json` 临时改为 `{"enabled": true}`，`cd windows\host` 后 `..\.venv\Scripts\python.exe -u companion.py`，再触发 `AR1V`；结束后恢复 `{"enabled": false}` | `windows\.local\companion.log` 无 TLS/连接错误；无 VB-CABLE 时走 `ABORT`/`ACK` 路径（板端 `Voice session ended (12)`） |
| D6 真实听写（需用户） | 安装 VB-CABLE 并把 `CABLE Output` 设为默认录音设备；Codex 登录并放前台；Screen 点 `Voice` 说话后点 A | Codex 收到文字；Codex/VB-CABLE 不可用时此项标注为「未测」 |

> 会话结果码（串口 `Voice session ended (n)`）：`6`=CANCELLED、`8`=NO_PC、`10`=NETWORK_ERROR、
> `12`=SEND_ERROR（E2E/ABORT 路径正常值）、`14`=SUBMITTED。

## 5b. 阶段 DSH：语音目标切换（task-4，代码轮完成待实测）

> 设计、调研与限制见 [voice-targets.md](voice-targets.md)。以下步骤需要用户本机 DSH 桌面版。

| 步骤 | 操作 | 期望 |
| --- | --- | --- |
| F1 准备 DSH | DSH 桌面版 → 插件 → 语音输入：确认已启用；在插件详情「Download and prepare」准备 SenseVoiceSmall 模型（首次需联网下载，之后本地） | 麦克风按钮可点击（不再是「打开语音输入引导」）；DSH 内录音 → 停止 → 文字出现在草稿 |
| F2 选输入设备 | 同一插件详情 →「输入设备」→ 选 `CABLE Output (VB-Audio Virtual Cable)`（系统默认也行，但需临时把 Windows 默认录音设备改成 CABLE Output 再还原） | 选择被记住（重开设置仍在） |
| F3 切换目标 | 辅助程序 →「烧录开发板」→ 语音目标 → DeepSeek Harness；主窗口应显示 `语音目标 · DeepSeek Harness 语音输入（实验）`；`windows\.local\companion-settings.json` 出现 `"voice_target": "dsh"` | 立即保存；下一次语音会话生效，无需重启服务 |
| F4 自动触发可行性 | 在 DSH 正常启动状态下运行 `powershell -NoProfile -ExecutionPolicy Bypass -File windows\host\dsh_dictation.ps1 -Operation Start` | 模型未准备时应返回 `{"ok":false,"reason":"setup_required"}`（2026-11-09 本机实测即此状态）；模型准备后应返回 `{"ok":true,"manual":false,"window":...,"recording":...}`。若返回 `{"ok":false,"reason":"automation_unavailable"}`，用 `DeepSeek Harness.exe --force-renderer-accessibility` 重启 DSH 后再测；仍不可用则进入 F5 手动模式 |
| F5 端到端（自动或手动） | 开发板点 `Voice` → 对板载麦克风说话 → 点 A（或 DSH 里点「停止并识别」） | 自动模式：`companion.log` 出现 `Voice target: dsh`；DSH 自动开始/停止录音；草稿出现识别文字；板端状态 `Draft requested in Codex`。手动模式：`companion.log` 出现 `DSH voice controls are not automatable`，音频仍写入 CABLE，DSH 手动录音可收到板块音频，`DSH_MANUAL` 状态 |
| F6 异常路径 | 未准备模型时切换 DSH 目标并发起语音；关闭 DSH 后再发起 | 分别得到 `DSH_SETUP_REQUIRED` / `DSH_UNAVAILABLE`，板端显示失败状态且**不会**把音频误送进 Codex |
| F7 切回 Codex 回归 | 目标切回 Codex，重复一次原有 Codex 听写流程 | 与旧版行为一致（A 发送、B 取消、前台要求不变） |
| F8 打包验证 | `powershell -ExecutionPolicy Bypass -File windows\Build-App.ps1` 后运行 EXE，检查 DSH 目标 | 打包后的 `app\_internal` 内有 `dsh_dictation.ps1`；EXE 内切换目标后 DSH 路径可用 |

## 6. 阶段 E：Windows 回归与最终交付

| 步骤 | 命令 | 期望 |
| --- | --- | --- |
| E1 单元测试 | `cd windows; .\.venv\Scripts\python.exe -m unittest discover -s tests` | `Ran 14 tests ... OK` |
| E2 协议自检 | `cd windows\host; ..\.venv\Scripts\python.exe -u offline_check.py` | `Encrypted audio, Codex submit/draft/cancel/legacy, DSH draft/cancel/manual/setup, missing cable, and ambiguous send passed.` |
| E3 打包 | `powershell -NoProfile -ExecutionPolicy Bypass -File .\windows\Build-App.ps1` | 生成 `windows\app\CodexAirRemote.exe`，无错误 |
| E4 EXE 自检（需 Codex 登录） | `windows\app\CodexAirRemote.exe --test-report windows\.local\self-test.json` | JSON `{"ok": true}`（Codex 未登录会返回错误说明，属用户环境项） |
| E5 清理决策 | 决定 `AR1V`、`lv_mem` 打印、httpd DEBUG 日志的最终去留 | 若删除 `AR1V`，需在本清单里补一条无头触发替代方案，否则 D2 无法自动执行 |
| E6 最终 diff | `git status` / `git diff` | 仅包含预期改动；`git commit`（不 push，除非用户要求） |

## 7. 期望日志索引（排查用）

| 现象 | 关键日志/命令 |
| --- | --- |
| 板子没广播 | 启动日志缺 `BLE HID started`/`BLE advertising started`；出现 `HID start event missing, not advertising`（兜底定时器只诊断、不伪造广播） |
| Windows 搜不到但板子已广播 | `Get-PnpDevice`、Windows 蓝牙设置；确认板子不在语音会话（会话期间 BLE 被释放） |
| 光标不动 | 板端 `BLE host connected`？UI 是否 `Mouse active`？`mouse_probe.py` 的 moved samples |
| 卡键 | `mouse_probe.py` 汇总里的 `WARNING: button state mismatch`/`held`；板端报告正常但 PC 卡住则查 HID |
| 语音会话启动即失败 / `Voice session ended (10)` | 查 `BT release failed: ...`、`HID report still in flight, keeping the BT stack up`：BLE 链路半死（ATT confirm 丢失）时保护性中止，需要重启板子；正常会话不应出现 |
| PULL 无响应/缓冲溢出 | 板端 `PCM buffer full`；正常拉流时串口应有每秒 1 行 `sent seq ...`；确认本轮 `WIFI_PS_NONE` 已生效（无专门日志，可看帧间隔） |
| TLS 失败 | `mbedtls_ssl_handshake` 错误码；确认 PC 端强制 TLS 1.2 |
| 发现失败 | `discovery reply` 是否出现 `41523141...`；PC 是否绑定 47682；热点是否 `192.168.137.1` |
| BLE 初始化失败 | `BLE init failed: ...`（分阶段回滚）；`BLE host resumed: ...` 应为 `ESP_OK` |
| DSH 目标返回 `DSH_UNAVAILABLE` | DSH 未运行 / 主窗口最小化 / Chromium 无障碍未暴露；先打开 DSH 窗口再测；查看 `companion.log` 中以 `DSH voice controls are not automatable` 开头的告警 |
| DSH 目标返回 `DSH_SETUP_REQUIRED` | DSH 语音输入模型未准备：到 DSH 插件详情下载并把 SenseVoice 准备好 |
| DSH 手动模式收不到板载音频 | 确认 DSH 插件详情的「输入设备」是 CABLE Output、Windows 声音设置里 CABLE Output 存在；板端会话期间在 DSH 点「开始录音」 |
| DSH 只出草稿不发送 | 预期行为：DSH 语音输入不会自动发送；请在 DSH 中确认后发送 |
| 切换目标后行为没变 | 设置只在**下一次**语音会话读取；确认 `windows\.local\companion-settings.json` 的 `voice_target` 值，并确认 companion 服务是同一实例（`Local\CodexAirRemoteCompanion` 互斥体） |

## 8. 证据留档

| 内容 | 位置 |
| --- | --- |
| 启动日志 | `firmware/build/boot-latest.txt` |
| E2E 板端日志 | `firmware/build/voice-e2e-board.txt` |
| 鼠标观察数据 | `firmware/build/mouse-probe.csv`、`mouse-probe-board.txt` |
| Windows companion | `windows/.local/companion.log` |
| 烧录/配网历史 | `windows/.local/setup.log` |
| EXE 自检 | `windows/.local/self-test.json` |

## 8. 审计后待实测清单（按风险排序，2026-11-09 代码审计轮产出）

> 依据见 [`firmware-audit.md`](firmware-audit.md)。全程不要求用户改动环境；每步失败先回退到上一步再继续。

| 顺序 | 项目 | 怎么测 | 期望 | 失败回退 |
| --- | --- | --- | --- | --- |
| 1 | **显示点亮（最高风险）** | 用 env IDF 编译烧录，看屏幕 | 出现 UI（Gyro/Voice/A/B） | 黑屏 → 改 `CONFIG_BOARD_LCD_PINS_VARIANT_B=y` 重烧；仍黑 → 报回代码轮 |
| 2 | 触摸 | 点 A/B/Gyro，观察界面响应 | 点击准确、无偏移/镜像 | 调 `display_bsp.cpp` 中 `swap_xy/mirror_*` 或 x_max/y_max |
| 3 | 亮度/息屏 | 静置 25 s 后触摸 | 变暗后触摸恢复 70% | 检查 `app_main` 亮度逻辑与 0x51 命令 |
| 4 | 开机日志 | 串口 115200 | `BLE HID started`、`BLE advertising started`、`AIRREMOTE UI READY`、无 panic | 记录完整日志报回 |
| 5 | BLE 配对 | Windows 蓝牙添加设备 | 出现 `Codex Air Remote` 并可配对 | 复查 GATTS 回调注册与广播日志 |
| 6 | 鼠标/按键 | Gyro 模式倾斜 + A/B | 光标平滑、左右键 down/up 对称、无卡键 | 记录 `mouse_probe` 数据；核对 CCC 就绪日志 |
| 7 | 语音 E2E | 如常录音并点 A | 发现→TLS→WSS→READY2→CAPTURE/GO→连续 PCM 帧，无 `PCM buffer full` | 记录板端/PC 端日志；检查 WIFI_PS_NONE 与帧间隔 |
| 8 | Codex 听写 | 目标 Codex 前台，说话后 A | Codex 收到文字 | 复查 UIA 控制与 VB-CABLE |
| 9 | DSH 语音目标 | 按 `docs/voice-targets.md` 配置后切换 | DSH 草稿出现文字（不自动发送） | 见阶段 DSH 清单 |
| 10 | 内存水位 | 记录启动与语音会话期间最小堆 | 无分配失败/panic | 调整 LVGL 栈/缓冲或 PCM 缓冲 |

### 引脚 A/B 变体

- 默认 A：`LCD CS=GPIO15`、`TOUCH INT=GPIO5`（社区同板实现 + 09 示例默认）。
- 变体 B：`LCD CS=GPIO5`、`TOUCH INT=GPIO15`（官方 C6 2.06 BSP 头文件）。
- 切换方式：`sdkconfig.defaults` 加 `CONFIG_BOARD_LCD_PINS_VARIANT_B=y` 后重新编译烧录；只改这一处。

## 9. 代码轮收尾状态（2026-11-09 第 14 轮）

| 项 | 状态 |
| --- | --- |
| 本机 IDF 5.5.5 构建 | ✅ 绿（`Project build complete`，bin 2,320,016 B） |
| env/ 内构建 | ⏳ 未闭环（工具链元数据缺失，见 `firmware-audit.md` 附录 B） |
| 临时探针清理 | ✅ 已删除（保留 AR1V 串口触发） |
| UI 组件化 | ⏳ UI 仍在 `main/app_main.c`（功能可用，待迁 `app_ui`） |
| 引脚 A/B 变体 | ✅ `board_pins.h` + Kconfig 开关 |
| 审计与差异附录 | ✅ `docs/firmware-audit.md` |

### 第 15 轮更新（env 构建已闭环）

| 项 | 状态 |
| --- | --- |
| env 内 IDF 构建 | ✅ 绿：`Project build complete`，日志 `firmware/build/env-build.log` |
| 本机 IDF 构建 | ✅ 绿（同源码，先前验证） |
| 临时探针 | ✅ 已清理 |
| diff 附录 | ✅ `firmware-audit.md` 附录 A |
| UI 组件化（`app_ui`） | ⏳ 未完成（唯一剩余 Go 条件） |

### 第 16 轮（最终代码轮）：Go 条件全部满足

| Go 条件 | 状态 | 证据 |
| --- | --- | --- |
| 本机 IDF 构建绿 | ✅ | `Project build complete`，exit 0，bin 2,319,472 B（23:02:41） |
| env 内构建绿 | ✅ | `Project build complete`，exit 0，bin 2,319,472 B（23:01:00），日志 `firmware/build/env-build.log`（0 error） |
| 无临时探针 | ✅ | panel_probe/AR1D-AR1X/board diag 已删除；仅保留 AR1V 串口语音触发 |
| 与参考实现 diff 附录 | ✅ | `docs/firmware-audit.md` 附录 A/B |
| UI 已组件化 | ✅ | `components/app_ui`（`app_ui_init()` / `app_ui_set_capabilities()`，LVGL 自刷新 timer 与交互在组件内） |


## 11. 待机页 / 语音 / 陀螺仪（2026-11-11 修复后）

| 顺序 | 项目 | 怎么测 | 期望 |
| --- | --- | --- | --- |
| 1 | 待机页数字 | 静置 60 s（不触摸、不运行 Voice/Gyro） | 黑底出现完整 HH:MM（不再只有冒号），每秒走字，80% 背光；触摸唤醒不误触按钮 |
| 2 | 语音会话启动 | 点 Voice 或发 AR1V | 不再出现 PCM buffer allocation failed；进入 AUTH/READY2；日志可见 `BT released` 之后 `Wi-Fi ready` |
| 3 | 语音失败回滚 | 断网时点 Voice | 会话失败后 BLE 鼠标能恢复（`BT resume`），无 panic |
| 4 | 陀螺仪滚转 | 空中鼠标模式下只滚转手腕（右侧下压） | 光标不应竖向漂移（旧 bug：dy +1..+7） |
| 5 | 陀螺仪上下方向 | 前后倾斜 | 上下方向与手势一致（screen_normal/VERTICAL_SIGN 已同时修正） |
| 6 | 校准容差 | 手抖状态下点 Gyro 并保持大致静止 | 不再频繁重置，6 s 内完成校准 |
| 7 | 退出 Gyro 稳定性 | 反复进入/退出 Gyro 10 次（BLE 已连接） | 无 Guru/Store access fault；若仍崩溃记录日志与复现步骤（栈已加到 6 KiB，属可疑项） |
