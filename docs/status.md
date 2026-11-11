# 当前状态（滚动更新）

> 最后更新：2026-11-12。代码与固件均已在 `origin/main`；本文件只记录"最新状态"，历史细节见
> [`pending-hardware-validation.md`](pending-hardware-validation.md)、
> [`display-bringup-notes.md`](display-bringup-notes.md) 与 [`开发进度.md`](开发进度.md)。

## 1. 完成项（均已实机验证）

| 项目 | 结论 | 证据 |
| --- | --- | --- |
| 固件目录结构 / 双构建 | `main` 仅编排，组件拆分；本机 + env IDF 构建 0 error | `firmware/build/clock-build.log`、`env-build.log` |
| 待机页（P0） | 60 s 无操作 → 黑底大时钟（HH:MM 完整、每秒走字）+ 80% 背光；触摸唤醒不穿透；数字空白问题已修（字形蒙版改系统堆） | `standby: clock 20:20, row 450x115 px`、`standby: enter, idle 60002 ms, brightness 60 -> 80`；用户确认 |
| RTC / 时区 | PCF85063A 在板，`AR1T`/`AR1Z` 设置；开机日志 `RTC holds … UTC, display … tz +480` | 启动日志 |
| 陀螺仪（P1） | 方向正确（按键侧下压 → 向下）、roll 无位移、yaw 左右正确；"动一会儿就不动"已修（HID 上报 8→16 ms、失败容错 + CCC 重武装） | `gyro-fix.log`：`sent` 0→1329+、`rdy=1`、`drop=0`、无断连/无 notify 失败 |
| 语音会话顺序 / 回滚 | BLE 先释放再分配 16 KiB PCM（含 4×100 ms 重试）；失败时 `Voice session ended` → `busy: hold -voice`，BLE 恢复 | `BT released, heap free 77860` → audio ring OK → `Wi-Fi unavailable` → `hold -voice, mask 0x0` |
| 插件内置固件 | v0.4.1（commit `858ba89`，merged 4,577,280 B，sha256 `2a8c1f76…`），含待机/陀螺仪/语音修复 | `plugins/dsh-airremote/firmware/manifest.json` |
| 插件工程 | `npm run check/build/test` 全绿（host 3 项 / client bundle / 无头 Chrome） | 本轮输出 |

## 2. 阻塞项

### 语音 AUTH/READY2 未达成（2026-11-11）
- 现象：板端关联 Windows 热点失败，`Wi-Fi disconnected, reason 210 = NO_AP_FOUND_W_COMPATIBLE_SECURITY`；
  另外 companion（TLS/WSS 47683）当前未运行。
- 影响：`AR1V` 只能走到"释放 BLE → 启动 Wi-Fi → 无 AP 回滚"，无法验证 AUTH/READY2 与后续 PCM 上行。
- 待用户选择（三选一，任选其一即可继续）：
  1. 提供可用 **2.4 GHz 路由器 AP** 的 SSID/密码（我用 `AR1W` 配到板子）；
  2. 允许把 Windows 热点改为兼容安全模式（WPA2-PSK）后重试（属热点配置变更，需用户明确同意）；
  3. 暂缓语音，先做其他事项。

## 3. 剩余待办

| 项 | 说明 |
| --- | --- |
| 语音 AUTH/READY2 + PCM 上行 | 依赖上面"阻塞项"的 Wi-Fi/companion 条件 |
| 插件烧录 / 「开发板时间」真机回归 | 插件侧 esptool-js 烧录与 `AR1T/AR1Z` 校时；内置镜像已是 v0.4.1 |
| `bundle-firmware.mjs` 适配 esptool v5 | 现脚本 `merge_bin @flash_args` 参数不被 esptool v5 接受，当前用手动合并 + manifest 生成，需修正脚本 |
| BLE 0x13 每秒重连 | 陀螺仪/语音测试未复现；若再现，先删除 Windows 蓝牙设备重新配对 |
| 灵敏度/手感 | 用户认为可用，后续可按体感微调 `LINEAR_GAIN / QUADRATIC_GAIN / STOP_RATE` |
| 发布前 | `AIR_MOUSE_DIAGNOSTICS` 已默认 0（无需改）；待机参数维持 60 s / 80% |

## 4. 常用入口

- 待实测清单（步骤、期望日志、回退）：[`pending-hardware-validation.md`](pending-hardware-validation.md)
- 板级 bring-up 记录（黑屏误区、字体、RTC、陀螺仪、语音）：[`display-bringup-notes.md`](display-bringup-notes.md)
- 插件设计与路线图：[`plugin-dsh-airremote.md`](plugin-dsh-airremote.md)
- 换电脑继续开发：[`project-summary-and-usage.md`](project-summary-and-usage.md)
