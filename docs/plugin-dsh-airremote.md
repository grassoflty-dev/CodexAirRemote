# dsh-airremote 插件（设计说明与路线图）

> 决策：**放弃 Codex 语音支持**，把原 `windows/` 辅助程序改造为 **DSH 插件** `plugins/dsh-airremote`；
> 开发板语音不再经 VB-CABLE，而是直连插件 host，本地 whisper.cpp 转写后写入 DSH 草稿。

## 1. 为什么是插件

| 旧方案（windows/ 辅助程序 + Codex） | 新方案（dsh-airremote 插件） |
| --- | --- |
| 语音经 VB-CABLE → Codex 听写 → UIA 点击 | 板子 PCM → 插件 host → whisper.cpp → **DSH 草稿注入** |
| 依赖 Codex 窗口/快捷键/UIA，易受 UI 变化影响 | 只用 DSH 官方插件 API（slots/composer），无 UI 自动化 |
| 烧录/配网在独立 Tkinter 应用 | 同一插件内完成烧录、配网、麦克风与模型配置 |

## 2. 关键 API（来自 dsh-ears 0.4.4 源码验证）

- 插件清单：`package.json` 的 `dsh.bundle.patch` + `dsh.client.platform: "web"` +
  `dsh.client.inject: [@deepseek-ai/dsh-client-*]`；
- 客户端入口：`inject = ['slots', 'remote', 'locale']`，用
  `ctx.slots.inject('conversation.input.right', () => ctx.slots.register({...}, Component))`
  注入麦克风按钮；`conversation.input.dock` 注入录音状态条；`settings.section` 注入设置页；
- **草稿注入**：slot 组件 props 提供 `useInput(selector)`（读 `draft`）与
  `inputActions.setDraft(text)`（写草稿）；转写写入可编辑草稿、**不自动发送**；
- **快捷键**：页内 `window.addEventListener('keydown', handler, true)` + 和弦匹配，默认
  `Ctrl+Shift+Space`、设置页可改；非全局（窗口失焦不触发）。

## 3. 路线图

| 里程碑 | 交付 | 验收 |
| --- | --- | --- |
| M1 | client 按钮 + 页内快捷键 + 假 ASR（固定文本） | 在 DSH web 点击/快捷键后草稿出现固定文本 |
| M2 | host：UDP `AR1A` 发现 + TLS/WSS 47683 服务（复用固件 `voice.c` 帧）；PC 端模拟板子 e2e | 模拟板子 PCM 能进入 host 并产出音频帧 |
| M3 | whisper.cpp worker（`@fugood/whisper.node`，large-v3/turbo、CUDA）+ 术语表 + LLM 润色 | 中英文/电子术语样本对比 SenseVoice，延迟 ≤1.5s（4060 Ti） |
| M4 | esptool 烧录子进程 + 串口配网（复用 `windows/host/flash.py` 参数与 provision 命令） | 插件内完成烧录与配网（手动验证清单） |

## 4. 板子协议（沿用固件，不改）

- 发现：板端向 PC 网关 `47682` 发单播 `AR1A`+MAC；插件 host 绑定 `0.0.0.0:47682` 接收；
- 语音：TLS 1.2（双向证书）+ WSS `47683`，文本 JSON 信令（AUTH/READY2/CAPTURE/GO）+
  二进制 PCM 帧（16 kHz stereo），与 `firmware/components/app_voice/voice.c` 完全一致；
- 板端 A/B 键：A=开始/停止识别、B=取消，通过 host↔board 信令扩展实现（M2）。

## 5. 安全与复用

- 插件安装必须走 `/dsh-safe-launch/install-plugin`（~/.dsh/AGENTS.md 硬约束），不手工改 profile。
- 复用 dsh-ears（MIT）的快捷键解析（已用于 M1）、whisper worker/协议/模型管理思路（M3 计划）；
  保留版权与来源说明：见 `plugins/dsh-airremote/LICENSE-dsh-ears.txt` 与根 `THIRD_PARTY_NOTICES.md`。

## 6. 当前状态与阻塞

- **M1 代码级完成**（本仓库 `plugins/dsh-airremote/`，类型检查通过）；**M2 进行中**（host 板子链路）。
- **运行时验证待定**：当前桌面会话 `desktop` profile 未启用 `dsh-safe-launch`，安装端点 404；
  需要用户使用 `web` profile 的 DSH（含安全启动器）或明确授权后安装验证。
- `windows/` 已标记 **legacy（已退役）**，仅保留代码与历史；固件语音协议不变。
