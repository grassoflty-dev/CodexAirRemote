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

## 数据目录

`%USERPROFILE%\.dsh\airremote\`：

- `pairing.txt`：固件 `pairing.txt` 的 64 字符 token（秘密）；
- `server.crt`：板子自签名证书（TLS pin；缺失则不校验）；
- `simulate`：存在即启用模拟板子；
- `sim.wav`：模拟板子循环的 16 kHz mono WAV。

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
