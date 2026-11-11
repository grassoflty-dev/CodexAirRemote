# dsh-airremote

DeepSeek Harness 插件：把 **Codex Air Remote**（Waveshare ESP32-C6-Touch-AMOLED-2.16）开发板
变成 DSH 官方语音输入插件的 **虚拟麦克风**。板载麦克风音频经 TLS/WSS 直连插件 host，
再通过页面内的合成 `MediaStream` 交给官方 `voice-input`，由官方 SenseVoice 转写并写入草稿。

> `windows/` 辅助程序是旧方案（Codex 听写 / VB-CABLE），已标记 legacy；插件是新交付路径。
> 设计与协议细节见 [`../../docs/plugin-dsh-airremote.md`](../../docs/plugin-dsh-airremote.md)。

## 状态

| 里程碑 | 内容 | 状态 |
| --- | --- | --- |
| M-A | host：UDP `AR1A` 发现、TLS/WSS 47683 客户端、`/airremote/audio` 路由、模拟板子 | ✅ 模拟 e2e 通过 |
| M-B | client：虚拟麦克风 shim（enumerateDevices/getUserMedia、PCM→AudioContext、重连） | ✅ 无头 Chrome 测试通过 |
| M-C | 删除自有按钮、启用官方 voice-input、设备选 Air Remote、官方按钮→草稿 | ✅ Web GUI 端到端通过 |
| M3 | whisper.cpp worker | ⏸ 官方 SenseVoice 已覆盖 |
| M4 | esptool 烧录 + 串口配网 | ⏳ |

## 架构

```
ESP32-C6 ──WSS 47683──▶ host（TLS 客户端 + UDP 47682 发现）
                           │ dsh-host-webserver upgrade 路由 /airremote/audio
                           ▼
浏览器 ◀── WebSocket ── client shim（16k s16le → AudioBuffer → AudioContext）
                           ▼
              createMediaStreamDestination().stream（deviceId=airremote）
                           ▼
   官方 voice-input：getUserMedia → MediaRecorder → SenseVoice → 草稿
```

插件不注册自己的麦克风按钮；`conversation.input.dock` 只保留一条“Air Remote”状态提示。

## 安装

```powershell
cd plugins/dsh-airremote
npm install
npm run check
npm run build
```

然后必须走 DSH 插件管理安装（不要手工改 profile）：

```text
plugin_manager install_bundle  link:D:\C-Develop\CodexAirRemote\plugins\dsh-airremote
plugin_manager set_bundle      @deepseek-ai/dsh-experimental-voice-input-bundle  enabled=true
```

在官方语音输入设置里把输入设备选为 **Air Remote (ESP32-C6)**。

## 开发板时间（时区设置）

设置页 → **开发板时间**：一个时区下拉（跟随系统 / UTC−8 洛杉矶 / UTC−5 纽约 / UTC+0 伦敦 /
UTC+1 柏林 / UTC+8 北京 / UTC+9 东京）加一个「同步到开发板」按钮。

- 点「同步到开发板」时，host 才通过串口发两条命令：`AR1T <当前 UTC 秒>`（板载 RTC 只存 UTC）
  和 `AR1Z <偏移分钟>`（东为正，480 = UTC+8，存 NVS 的 `airremote_time` / `tz_min`）。
  板子两条都回 `OK` 才算成功；回 `ERR` 或超时按错误码上报。
- **只在点击时发生**：不监听 USB 插拔、不后台轮询、重连后也不自动补发。改下拉框只保存选择，
  不碰串口。
- 端口识别：按 USB VID `303A`（Espressif）找串口，优先用 `serialport` 包；不可用时回落到
  注册表 / PowerShell（`[System.IO.Ports.SerialPort]`）。要固定端口时设环境变量
  `AIRREMOTE_SERIAL_PORT=COM7`。
- 选择持久化在 `<DSH_HOME>/airremote/time.json`（见「数据目录」），**不走** profile 配置：
  保存 profile 会触发插件重载，打断正在进行的请求。
- 固件要求：需要 `41381c9`（RTC 只存 UTC）及以后的固件，且该固件支持 `AR1Z`。更早的固件把
  本地时间写进 RTC，时区会算错。

### HTTP 路由

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/airremote/time` | 读取保存的时区选择 |
| POST | `/airremote/time` | 保存时区选择 |
| POST | `/airremote/sync-time` | 用串口把当前时间与时区写给板子 |

响应都是 `application/json; charset=utf-8`；业务失败也是 HTTP 200，只有请求体不合法才 400。

`GET /airremote/time` → 200：

```json
{ "ok": true, "timezone": "auto", "updatedAt": "2026-11-11T05:44:00.000Z" }
```

`timezone` 未保存过时为 `"auto"`，`updatedAt` 未保存过时为 `null`。

`POST /airremote/time` 请求体 `{ "timezone": "auto" }`：字符串、长度 1..32、只允许
`[a-z0-9+_-]`（大小写不敏感，统一存小写）。合法 → 200 并返回与 GET 相同的结构（`updatedAt`
为本次写入时间）；不合法 → 400。

`POST /airremote/sync-time` 请求体 `{ "minutes": 480 }`：整数、`-720..840`（东为正）。成功：

```json
{ "ok": true, "port": "COM7", "unix": 1762836000, "minutes": 480,
  "lines": ["AR1T OK 1762836000", "AR1Z OK 480"] }
```

失败：

```json
{ "ok": false, "error": "no-board", "port": null, "lines": [], "message": "未找到 ESP32-C6 开发板（USB VID 303A）" }
```

| error | 含义 |
| --- | --- |
| `bad-request` | 请求体不合法（HTTP 400） |
| `no-board` | 找不到 VID 303A 的串口 |
| `open-failed` | 找到端口但打开失败（被占用 / 权限 / 驱动） |
| `timeout` | 命令发出后超时没等到 OK |
| `rejected` | 板子明确回了 `AR1T ERR` 或 `AR1Z ERR` |
| `busy` | 已有一次同步在进行中 |
| `internal` | 其它异常（`message` 带原因） |

`unix` 取自 **host 的系统时钟**（`Math.floor(Date.now()/1000)`），不用浏览器时钟；同一时刻只
允许一次同步，第二次直接回 `busy`。

## 数据目录

`%USERPROFILE%\.dsh\airremote\`：

- `pairing.txt`：固件 `pairing.txt` 的 64 字符 token（秘密）；
- `server.crt`：板子自签名证书（TLS pin；缺失则不校验）；
- `simulate`：存在即启用模拟板子；
- `sim.wav`：模拟板子循环的 16 kHz mono WAV；
- `time.json`：设置页「开发板时间」选的时区，`{ "timezone": "auto", "updatedAt": "<ISO>" }`
  （原子写：先写 `time.json.tmp` 再 rename；缺失或损坏按 `auto` 处理）。

真实板子使用前先在板子上点 **Voice**（或 USB 发 `AR1V`），让板子进入语音会话并广播。

## 测试

```powershell
npm test           # host + client bundle + 无头 Chrome MediaRecorder
npm run test:e2e   # 需要本机 DSH 已运行/已装插件/官方 voice-input 已启用/模型已缓存
```

`test:e2e` 使用 `~/.dsh/.credentials.yaml` 的 browser-session secret 自签 cookie，在独立无头
Chrome 里打开 Web GUI，点官方麦克风，模拟板子 PCM，读回 SenseVoice 写入的草稿。

## 复用与许可

- `src/host/ws.ts` 是自包含的 RFC 6455 子集（握手/掩码/文本/二进制/ping/close），不引入运行时依赖。
- 早期 M1 的快捷键解析改编自 [dsh-ears](https://github.com/WizisCool/dsh-ears)（MIT，
  Copyright (c) JUNZE）；M-C 后已删除自有按钮与快捷键，仅保留许可记录。
- 协议与 `firmware/components/app_voice/voice.c` 完全一致；模型/识别由官方 SenseVoice 提供。
