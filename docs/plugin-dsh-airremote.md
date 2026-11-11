# dsh-airremote 插件（设计说明与路线图）

> 决策：**放弃 Codex 语音支持**，把旧 `windows/` 辅助程序改造为 **DSH 插件** `plugins/dsh-airremote`。
> 开发板语音不再经 VB-CABLE，而是由插件 host 直连板子，**复用 DSH 官方语音输入插件**完成录音、
> 本地 SenseVoice 转写与草稿写入。插件自己不画麦克风按钮、不实现识别引擎。

## 1. 为什么是“虚拟麦克风”

官方语音输入插件（`@deepseek-ai/dsh-experimental-client-ui-voice-input`）的采集路径是：

```
enumerateDevices() 过滤 audioinput
        ↓ 用户选择设备（localStorage: dsh.voice-input.microphone）
getUserMedia({audio:{deviceId:{exact:id}, echoCancellation, noiseSuppression}})
        ↓
new MediaRecorder(stream) → WebM/Opus → decodeAudioData → 16 kHz mono WAV
        ↓
ctx.speechToText(sensevoice-local) → 写入 composer 草稿（不自动发送）
```

因此只要在**页面里**提供一个 deviceId 为 `airremote` 的合成 `MediaStream`，官方插件的按钮、
录音 UI、识别、草稿、设置页全部原样复用。插件只做两件事：

1. **host**：连接开发板 WSS，把 PCM 通过 `dsh-host-webserver` 的 upgrade 路由转给浏览器；
2. **client shim**：改写 `enumerateDevices` / `getUserMedia`，把 PCM 喂进
   `AudioContext.createMediaStreamDestination()`，伪装成名为 `Air Remote (ESP32-C6)` 的麦克风。

```
ESP32-C6 ──WSS 47683──▶ host 插件（TLS 客户端 + UDP 47682 发现）
                           │ dsh-host-webserver registerUpgrade('/airremote/audio')
                           ▼
浏览器 ◀── WebSocket ── client shim（16k s16le → AudioBuffer → 重采样 → AudioContext）
                           ▼
              createMediaStreamDestination().stream
                           ▼
   官方 voice-input：getUserMedia → MediaRecorder → speechToText → 草稿
```

## 2. 板子协议（以 `firmware/components/app_voice/voice.c` 为准）

- 发现：板子向 PC 网关/广播 `47682` 发 `AR1A` + 6 字节 MAC；host 绑定 `0.0.0.0:47682` 接收，
  并每秒发 `AR1?` + 16 字节探测（板子回 `AR1!` + MAC）。
- 语音：板子是 **TLS 1.2 服务端**，host 是客户端，连 `wss://<board>:47683/voice`；
  证书是固件内嵌的自签名证书（CN=`airremote.local`），客户端用 `AUTH <64 字符 pairing token>` 认证。
- 信令（文本帧）：`AUTH` → `READY2` → `CAPTURE` → `GO`；之后 host 反复 `PULL`，
  板子回二进制帧或 `WAIT` / `SEND` / `CANCEL`；host 结束发 `ABORT`（录音中）或
  `DRAFTED` / `CANCELLED`（板子已进入识别态），板子回 `ACK`。
- 二进制帧：4 字节大端序号 + PCM。`voice.c` 把 ES7210 的 16 kHz stereo 下混成
  **16 kHz mono s16le**，每帧 640 字节（20 ms）；host 转发时去掉 4 字节序号，浏览器只收裸 PCM。
- 板子单次录音上限 60 s；host 在 65 s 主动收尾。

## 3. 里程碑

| 里程碑 | 交付 | 状态 |
| --- | --- | --- |
| M1 | 自定义麦克风按钮 + 页内快捷键 + 假 ASR | 已被 M-C 取代（按钮删除） |
| M-A | host：UDP `AR1A` 发现 + TLS/WSS 47683 客户端 + `/airremote/audio` upgrade 路由 + 模拟板子 | ✅ 代码 + 模拟 e2e 通过 |
| M-B | client：`enumerateDevices`/`getUserMedia` 补丁、PCM→AudioContext→MediaStreamDestination、重连/欠载处理 | ✅ 代码 + 无头 Chrome MediaRecorder 测试通过 |
| M-C | 删除自有麦克风按钮；启用官方 `voice-input` bundle；设备选 `Air Remote (ESP32-C6)`；官方麦克风→草稿 | ✅ Web GUI 端到端通过（模拟板子） |
| M3 | 本地 whisper.cpp worker | ⏸ 暂不需要：官方 SenseVoice 已覆盖 |
| M4 | esptool 烧录 + 串口配网 | ⏳ 未做 |

## 4. 安装与配置

### 4.1 构建

```powershell
cd plugins/dsh-airremote
npm install
npm run check      # tsc --noEmit
npm run build      # rolldown（host/client/test bundle）+ tsc 声明
```

构建产物：

- `lib/index.js`：host ESM 入口；
- `lib/client.js`：DSH 模块加载器要求的 `window.__ModuleLoader__.load({id,factory})` 包装；
- `lib/*.d.ts`：类型声明；
- `test/dist/*`：仅测试用（已 gitignore）。

### 4.2 安装到 DSH

必须走 DSH 插件管理，不手工改 profile：

- 在 DSH 里用 `plugin_manager` 工具（或 Web 侧栏“插件”）安装
  `link:D:\C-Develop\CodexAirRemote\plugins\dsh-airremote`（开发）或打包后的本地路径；
- 启用 `@deepseek-ai/dsh-experimental-voice-input-bundle`（官方语音输入 bundle）；
- 打开官方语音输入设置，把输入设备选为 **Air Remote (ESP32-C6)**。
  插件首次加载会把该设备写进 localStorage 默认值；若用户已选过真实麦克风，则保留用户选择。

### 4.3 数据目录

host 默认读取 `%USERPROFILE%\.dsh\airremote\`：

| 文件 | 用途 |
| --- | --- |
| `pairing.txt` | 固件 `pairing.txt` 的 64 字符 token（**秘密**） |
| `server.crt` | 板子自签名证书，用作 TLS pin；缺失时退化为不校验（仅开发） |
| `simulate` | 存在即启用模拟板子（本机联调开关） |
| `sim.wav` | 模拟板子循环播放的 16 kHz mono WAV；缺失时生成双音测试音 |

环境变量覆盖：`AIRREMOTE_DATA_DIR`、`AIRREMOTE_PAIRING_FILE`、`AIRREMOTE_PAIRING_TOKEN`、
`AIRREMOTE_CA_FILE`、`AIRREMOTE_BOARD_HOST`、`AIRREMOTE_BOARD_PORT`、`AIRREMOTE_DISCOVERY_PORT`、
`AIRREMOTE_DISCOVERY_TIMEOUT_MS`、`AIRREMOTE_SIMULATE=1`、`AIRREMOTE_SIM_WAV`、`AIRREMOTE_SIM_PORT`。

### 4.4 使用步骤（真实板子）

1. 板子上点 **Voice**（或 USB 串口发 `AR1V`）启动一次语音会话；
2. 板子释放 BLE、连 Wi-Fi、广播 `AR1A`；
3. 在 DSH 点官方麦克风按钮；
4. host 发现板子 → TLS 连接 → AUTH → CAPTURE → 开始收 PCM；
5. 再点官方按钮停止（或板子 A 键发送 / B 键取消）；
6. 官方 SenseVoice 转写 → 草稿出现文字，可编辑、不自动发送。

> 注意：板子只在 **Voice 会话**期间开 Wi-Fi/TLS；点官方麦克风前必须先让板子进入 Voice 模式。
> host 等待 30 s，超时会提示“等待开发板（请在板子上点 Voice）”。

## 5. 验证

```powershell
cd plugins/dsh-airremote
npm test                 # host 集成 + client bundle + 无头 Chrome MediaRecorder
npm run test:e2e         # 需要本机 DSH 正在运行、已装插件、已启用官方 voice-input、模型已缓存
```

`test:e2e` 会：

1. 用 `~/.dsh/.credentials.yaml` 里的 browser-session secret 自签一个 cookie，打开
   `http://127.0.0.1:57648/`（独立无头 Chrome，不碰桌面窗口）；
2. 确认 `enumerateDevices` 出现 `airremote`，localStorage 选择为 Air Remote；
3. 点官方麦克风 → 模拟板子 16 kHz PCM → 官方 MediaRecorder → SenseVoice；
4. 从 composer 读回转写文字并截图。

已验证记录（2026-11-11）：

- `npm test`：WebSocket 握手/文本/二进制、模拟板子发现+会话、audio route、client bundle、
  无头 Chrome MediaRecorder 合成流全部通过；
- `npm run test:e2e`：官方按钮 → 虚拟麦克风 → SenseVoice → 草稿
  `"是语音。 请把这句话写。"`（模拟语音的识别结果），截图 `.local/e2e-web.png`；
- SenseVoice 模型已缓存并校验：`model.int8.onnx` 239,233,841 B / `tokens.txt` 315,894 B /
  `silero_vad.onnx` 1,807,522 B，SHA-256 与 provider `assets.json` 一致。

## 6. 风险与未决项

- **真实板子未在本轮联调**：本机当前无 ESP32-C6 串口；TLS/WSS 客户端、AUTH/帧格式按
  `voice.c` 实现，并用模拟板子覆盖协议，但真实 Wi-Fi/防火墙/证书仍需实机验证。
- **Windows 防火墙**：host 监听 UDP 47682，板子入站可能被拦；首次使用需允许 Node/DSH 的
  专用网络入站，或配置 `boardHost` 跳过发现。
- **TLS 校验**：有 `server.crt` 时 pin 证书并校验 CN；没有时 `rejectUnauthorized:false`
  （可被中间人）。生产部署应始终放 `server.crt`。
- **官方设置页预览**：设置页选中 Air Remote 时会调用 `getUserMedia` 做电平预览，但 shim 只在
  `MediaRecorder.start()` 后才连板子，因此预览电平为静音；这是有意的（避免打开设置就抢占板子）。
- **设备偏好**：若用户之前选过真实麦克风，插件不会覆盖；需要手动在官方设置里选 Air Remote。
- **板子必须先进入 Voice 模式**：host 不能远程唤醒板子的语音会话（固件没有该命令）。
- **ABORT 的板子状态**：浏览器先于板子 A/B 键停止时，host 发 `ABORT`，板子会以
  `VOICE_SEND_ERROR` 结束本次会话（屏幕短暂显示错误），下一次 Voice 不受影响。
- **插件安装是 `link:` 开发链接**：`npm run build` 后 host 需要重启插件条目才加载新代码；
  client bundle 由 HMR 自动替换。
- **`/airremote/audio` 升级路由不受页面 cookie 保护**：已加 Origin 同源校验（允许
  `dsh-app:`/`file:`），但同源页面仍可打开；这是本机 loopback 服务的固有边界。
