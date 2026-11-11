# dsh-airremote

DeepSeek Harness 插件：把 **Codex Air Remote**（Waveshare ESP32-C6-Touch-AMOLED-2.16）开发板
变成 DSH 的语音输入设备——板载麦克风音频经 TLS/WSS 直连插件，本地 whisper.cpp 转写，
结果写入 DSH 草稿（可编辑、不自动发送）；插件同时负责开发板烧录与串口配网。

> 本仓库的 `windows/` 辅助程序是旧方案（Codex 听写 / VB-CABLE），已标记 legacy；
> 插件是新的交付路径，见 [`../../docs/plugin-dsh-airremote.md`](../../docs/plugin-dsh-airremote.md)。

## 状态

| 里程碑 | 内容 | 状态 |
| --- | --- | --- |
| M1 | 客户端麦克风按钮 + 页内快捷键 + 假 ASR → 草稿注入 | ✅ 代码级完成（类型检查通过），运行时验证待定（安全启动器安装通道） |
| M2 | host：UDP `AR1A` 发现 + TLS/WSS 47683 语音服务（复用固件 `voice.c` 帧格式） | 🚧 进行中 |
| M3 | whisper.cpp worker（large-v3/turbo，CUDA）+ 术语表 + LLM 润色 | ⏳ |
| M4 | esptool 烧录 + 串口配网 | ⏳ |

## 架构

```
plugins/dsh-airremote/
├─ package.json        # dsh.bundle.patch + dsh.client(platform: web, inject …)
├─ cordis.patch.yml    # 把插件插入 profile 的 cordis 配置
└─ src/
   ├─ index.ts         # host 入口（生命周期 + 设置）
   ├─ config.ts        # 设置默认值（模型/术语表/端口/烧录参数）
   ├─ shortcut.ts      # 页内快捷键和弦解析（改编自 dsh-ears，MIT）
   └─ client/
      ├─ index.ts      # 注册 conversation.input.right / conversation.input.dock
      ├─ AirRemoteButton.tsx  # 麦克风按钮（点击或 Ctrl+Shift+Space）
      ├─ AirRemoteBar.tsx     # 录音/识别状态条
      └─ voice-state.ts       # 客户端语音状态
```

M1 假 ASR：点击按钮或按 `Ctrl+Shift+Space` → 1 秒后把固定文本写入 composer 草稿，
用于验证"插件 → 草稿注入"链路。M2 起把音频源换成板子 WSS PCM，M3 换成 whisper worker 转写。

## 安装（必须走安全启动器）

插件安装必须通过 DSH 安全启动器端点（见 `~/.dsh/AGENTS.md`），不要直接改 profile：

```powershell
# 端点由 DSH 运行时提供（示例；端口以实际 DSH 服务为准）
POST http://127.0.0.1:<dsh-port>/dsh-safe-launch/install-plugin
{"source": "dsh-airremote"}   # 或本地开发用 dsh-airremote 的 npm 包 / 本地路径
```

> 当前桌面会话的 `desktop` profile 未启用 `dsh-safe-launch` 插件，端点为 404；
> 运行时验证需用户使用 `web` profile（含安全启动器）或明确授权后安装。

## 开发

```powershell
cd plugins/dsh-airremote
pnpm install        # 需要 @deepseek-ai/dsh-client-* 等 peer 依赖（npm registry）
pnpm build          # tsdown + 类型声明
pnpm check          # tsc --noEmit
```

## 复用与许可

- `src/shortcut.ts` 改编自 [dsh-ears](https://github.com/WizisCool/dsh-ears)（MIT，Copyright (c) JUNZE），
  保留原协议与匹配语义；修改点见文件头注释。
- 后续 M2–M4 计划复用 dsh-ears 的 whisper worker/protocol/模型管理思路（同样 MIT），
  使用时保留版权与来源说明，见仓库根 `THIRD_PARTY_NOTICES.md`。
