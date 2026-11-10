# 语音目标：Codex / DeepSeek Harness（DSH）

> 状态：2026-11-09 代码轮完成（未实机）。目标切换、路由、离线测试已就绪；
> DSH 侧依赖用户一次性配置，实机验收步骤见 [`pending-hardware-validation.md`](pending-hardware-validation.md)。

## 1. 现状分析

原来的语音链路是**硬编码 Codex 单目标**：

```
板端麦克风 PCM ──TLS/WSS──> companion.py
                              │ ① CablePlayback: 写入 VB-CABLE（CABLE Input）
                              │ ② dictation.py / dictation.ps1：UIA 点 Codex 的
                              │    「听写/转录并发送/停止听写/取消听写」按钮
                              ▼
                       Codex 桌面听写（Codex 自己用 CABLE Output 做 STT）
```

关键事实：**识别（STT）由目标应用自己完成**，companion 只负责“喂虚拟麦克风 + 点按钮”，
不接触识别文本。因此要支持 DSH，最自然的做法不是“文本注入”，而是让 DSH 也把
VB-CABLE 当麦克风、由 DSH 自己转写。

## 2. DSH 侧调研结论

调研对象：本机安装的 DeepSeek Harness 桌面版（Electron），`resources/app.asar` 内的
`@deepseek-ai/dsh-experimental-voice-input-bundle` 与
`@deepseek-ai/dsh-experimental-client-ui-voice-input`（v0.2.2-rc.1），以及
`@deepseek-ai/dsh-experimental-speech-to-text-sensevoice`。

- **语音输入已内置且桌面 profile 已启用**：`~/.dsh/profiles/desktop/package.json` 的 bundles
  列表包含 `@deepseek-ai/dsh-experimental-voice-input-bundle`（web profile 没有）。
- **交互方式**：聊天区模型选择器与发送按钮之间有一个麦克风按钮；点击后出现录音工具条
  （Cancel / Stop + 电平波形）；点 Stop 后转写并插入**会话草稿**（不会自动发送）。
  可访问名称（aria-label，取自插件 i18n）：`开始录音`、`停止并识别`、`取消`；
  未准备模型时为 `打开语音输入引导`。
- **识别是本机 CPU 的 SenseVoice**：`SenseVoiceSmall ONNX + Silero VAD`（sherpa-onnx-node），
  首次需在插件详情「Download and prepare」，默认 int8，模型从 Hugging Face / HF-Mirror 下载；
  准备完成后完全本地识别，不经过云端。支持中文/英语/粤语/日语等（插件语言选择）。
- **输入设备可选且会记住**：插件详情有「输入设备」选择器，可跟随系统默认或显式选某个浏览器麦克风；
  选择结果由浏览器记住（`dsh.voice-input.microphone`），与 Host 识别设置独立。
- **没有自动发送/常开麦/唤醒词**（插件 README 明确列为未实现），也没有全局热键：
  `client.js` 未注册快捷键，仅在录音工具条内处理 Escape 取消。
- **可访问性（2026-11-09 本机实测，只读）**：Chromium 的 UIA 树会在 UIA 客户端查询时按需激活——第一次查询只看到 3 个窗口按钮，
  之后的查询能看到 **189 个按钮**；其中语音控件当前是「打开语音输入引导」（因为 SenseVoice 模型尚未准备），
  说明**模型准备后自动点击 `开始录音` / `停止并识别` 是可实现的**（待模型准备后复测）。脚本内置 4×250 ms
  重试以覆盖按需激活的延迟；若仍看不到语音控件，才回退手动模式。

## 3. 方案结论（a/b/c）

### a) 输入设备选择：**由用户在 DSH 里一次性选择 CABLE Output**（推荐，已采用）

- 做法：DSH → 插件 → 语音输入详情 →「输入设备」选 `CABLE Output (VB-Audio Virtual Cable)`。
  这是插件原生支持、且会被浏览器持久化的一次性配置。
- 理由：不需要改 Windows 全局默认录音设备（不影响 Teams/会议软件），不需要 COM
  `IPolicyConfig` 之类的非公开 API，也不需要逆向 DSH 的持久化存储格式。
- 备选（未采用）：辅助程序在服务运行时切换系统默认录音设备并在退出时恢复——实现复杂、
  影响全系统且与 DSH 插件“显式设备优先”的行为冲突。

### b) 触发方式：**UIA 自动点击（尽力）+ 手动模式回退**（已实现）

- 实现：`dsh_dictation.ps1` 按可访问名称查找 DSH 主窗口里的
  `开始录音` / `停止并识别` / `取消` 按钮并 `Invoke()`；`Start` 成功后等待录音工具条出现，
  返回窗口句柄 + cancel 按钮 runtime-id 作为会话标识，`Stop/Cancel` 校验会话后再点击。
- 已识别三种不可自动化的结果：
  - `automation_unavailable`：UIA 看不到语音控件（首次查询尚未激活时的兜底）→ **手动模式**；
  - `setup_required`：麦克风按钮变成「打开语音输入引导」→ 提示先准备 SenseVoice 模型
    （2026-11-09 本机实测就是这一状态）；
  - `window_not_found`：DSH 没运行 → 同手动模式处理（音频仍然送 CABLE）。
- **手动模式语义**：companion 照常把板端音频写入 CABLE；用户在 DSH 里自己点「开始录音」/「停止并识别」；
  板端 A/B 无法控制 DSH（A 仍会结束会话并返回“草稿”状态，B 直接结束）。
- 备选（未采用）：给 DSH 写插件注册全局热键——需要改 DSH 插件体系与用户配置，成本高且与本项目
  “辅助程序内切换”的目标不匹配；可作为后续增强。
- 若要尝试启用自动点击（待实测）：用
  `"C:\Users\...\Programs\DeepSeek Harness\DeepSeek Harness.exe" --force-renderer-accessibility`
  启动 DSH，然后用 `windows\host\dsh_dictation.ps1 -Operation Start` 验证能否返回 `ok:true`。

### c) Codex 不回归：**目标抽象 + 路由，Codex 路径原样保留**（已实现）

- `voice_target.py` 定义 `CodexTarget` / `DshTarget`：
  - 两者都复用 `CablePlayback`（VB-CABLE 播放）；
  - Codex 目标继续调用原来的 `dictation.py`（UIA 驱动 Codex 听写），行为与之前一致；
  - DSH 目标调用 `dsh_dictation.py`（UIA 驱动 DSH 语音输入），停止后返回 `DRAFTED`
    （DSH 只写草稿，不自动发送）。
- `companion.route_audio()` 每次会话开始时读取设置并选择目标；未配置/非法值一律回退 Codex；
  选 DSH 但 DSH 不可用时**不会静默改投 Codex**，而是明确返回 `ABORT` + 状态
  `DSH_UNAVAILABLE` / `DSH_SETUP_REQUIRED`（避免把音频误送进 Codex 对话）。

## 4. 配置与切换

- 设置文件：`windows/.local/companion-settings.json`
  ```json
  { "enabled": true, "voice_target": "codex" }
  ```
  `voice_target` ∈ `codex` | `dsh`；缺失或非法 → `codex`。`enabled` 语义不变。
- 切换入口：辅助程序 →「烧录开发板」窗口 →「语音目标」单选（`setup_dialog.py`）；
  主窗口「语音目标」一行会显示当前选择。
- 生效方式：**热切换**——companion 每次语音会话开始时读取设置，下一次 Voice 会话即生效，
  无需重启服务、无需重启程序。
- 迁移兼容：旧版只有 `{"enabled": bool}` 的设置文件可直接读取；写设置时保留其他键。

## 5. 协议与状态映射

| 板端动作 | Codex 目标（原行为） | DSH 目标 |
| --- | --- | --- |
| 录音开始（CAPTURE→GO） | 点 Codex「听写」 | 点 DSH「开始录音」；UIA 不可用时进入手动模式 |
| A / `SEND` | 点「转录并发送」→ `SUBMITTED` | 点「停止并识别」→ 文字进草稿，回 `DRAFTED`（不自动发送） |
| 长按/草稿 `DRAFT` | 点「停止听写」→ `DRAFTED` | 同 A：停止识别 → `DRAFTED` |
| B / `CANCEL` | 点「取消听写」→ `CANCELLED` | 点「取消」→ `CANCELLED` |
| 手动模式 | — | 不做任何点击，回 `DRAFTED` + 状态 `DSH_MANUAL` |

新增的辅助程序状态（`companion-state.json` / 主窗口“最近一次设备语音状态”）：
`DSH_UNAVAILABLE`、`DSH_SETUP_REQUIRED`、`DSH_MANUAL`。

## 6. 限制与风险

1. **DSH 语音输入是实验特性**，插件版本 0.2.2-rc.1；DSH 升级可能改变按钮文案/结构，需要复测。
2. **首次使用要准备模型**：SenseVoice 模型需在 DSH 插件详情下载（磁盘/内存/时间开销见 DSH 提示），
   未准备时返回 `DSH_SETUP_REQUIRED`。
3. **自动点击依赖 Chromium 无障碍**：实测 UIA 查询可激活（189 个按钮可见），但**模型未准备时**只能看到
   「打开语音输入引导」→ 返回 `DSH_SETUP_REQUIRED`；准备模型后需复测 `开始录音/停止并识别` 是否可自动点击，
   不可用时回退手动模式并用 `--force-renderer-accessibility` 重启 DSH 再试。
4. DSH 只把识别结果写进草稿，**不自动发送**；需要用户在 DSH 里确认发送。
5. 手动模式下 DSH 录音的开始/停止由用户控制，板端 A/B 只结束会话，不做点击。
6. Codex 路径保持原有“目标 Codex 窗口必须在前台”的要求。

## 7. 相关文件

| 文件 | 作用 |
| --- | --- |
| `windows/host/voice_target.py` | 目标抽象与选择（`CodexTarget` / `DshTarget`） |
| `windows/host/dsh_dictation.py` | DSH 语音输入控制的异步封装与错误分类 |
| `windows/host/dsh_dictation.ps1` | 按可访问名称驱动 DSH 麦克风 / Stop / Cancel |
| `windows/host/companion.py` | 按目标路由音频与会话（`route_audio`） |
| `windows/host/app_runtime.py` | `voice_target()` / `set_voice_target()` 持久化 |
| `windows/host/setup_dialog.py` | 语音目标单选与说明 |
| `windows/host/offline_check.py` | Codex/DSH 双目标协议离线验证 |
| `windows/tests/test_voice_target.py` | 设置、选择、DSH 回退/异常的单测 |
