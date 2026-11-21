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

## 安装 / 更新 / 卸载

> 仓库内插件 `0.5.7`，内置固件 `0.7.3`；Discover 仍提供 `0.5.5` / `0.7.2`。
> `0.7.3` 已知旋转后可能持续上下错位，尚未通过旋转验收。已验证的 DSH：**0.2.2-rc.3**；最低要求 `>=0.2.0-rc.1`。

### 方式一：本地 tarball（最稳，推荐给离线/单机环境）

1. 在仓库外生成安装包（或直接用已生成的包）：
   ```powershell
   cd plugins/dsh-airremote
   npm pack --pack-destination E:\Develop\airremote-dist
   # 产物：E:\Develop\airremote-dist\dsh-airremote-0.5.7.tgz
   ```
2. 交给 DSH 官方插件管理入口安装（`target` = tarball 的**绝对路径**）：
   ```text
   plugin_manager install_bundle  E:\Develop\airremote-dist\dsh-airremote-0.5.7.tgz
   ```
3. 在 **Plugins → Installed** 确认 `dsh-airremote` 已启用。更新已装版本后重启 DSH，再核对设置页显示的内置固件版本。若更新报 `@serialport/bindings-cpp` 的 `EPERM`，请先确认占用文件的旧宿主已退出，再用官方安装入口重试；不要手工修改 profile。

### 方式二：从 DSH 插件索引安装（Discover）

要求：已启用实验性插件市场 bundle
`@deepseek-ai/dsh-experimental-plugin-market-bundle`（提供 **Plugins → Discover**）。

1. **Plugins → Discover → Add index source**，填：
   ```text
   https://raw.githubusercontent.com/grassoflty-dev/CodexAirRemote/main/plugin-index.json
   ```
2. 搜索 **Air remote**（或 `dsh-airremote`）→ **Install**；
3. **Plugins → Installed** 启用 → 重载 DSH。

索引里的版本固定指向本仓库某个 commit（`git+https://…&path:/plugins/dsh-airremote`）；
仓库已提交构建好的 `lib/`，安装时无需本地重新编译。

### 方式三：本地目录（改代码时）

```powershell
cd plugins/dsh-airremote
npm install
npm run check
npm run build
```

```text
plugin_manager install_bundle  link:E:\Develop\CodexAirRemote\plugins\dsh-airremote
```

### 更新

> ⚠️ **更新插件前必须先完全退出 DSH**（托盘退出 / 结束所有 `DeepSeek Harness.exe` 进程）。
> Windows 会锁住已加载的 `@serialport/bindings-cpp` 原生 `.node`，DSH 运行中更新会让 pnpm 替换
> 该目录失败（`ERR_PNPM_EPERM`），插件随后报「串口原生模块不可用 / Cannot find module」。
> 若已经这样报错：退出 DSH 再重开即可恢复（依赖目录会被写回完整），一般**不需要重装**。

- 索引/本地目录：在 **Plugins** 里对该插件执行 Update，或重新 `install_bundle` 同一来源；
- tarball：生成新版本 tarball（`npm pack`）后用同一 `install_bundle` 指向新 tgz；
- 插件版本号与内置固件版本号是两套（见「两套版本号」一节）。

### 卸载

```text
plugin_manager remove_bundle  dsh-airremote
```
卸载只移除插件本身，**不会**修改开发板固件，也不会清除开发板上的配对/配网/时区。

### 安装后

到 **Plugins → Installed** 启用 `dsh-airremote`，然后：
- 设置页只有一个 **Air remote** 条目，页面内含「开发板时间」与「固件烧录」两块；烧录前先点 **「扫描设备」** 检查开发板（宿主只枚举串口，不打开端口），扫到后再点「开始烧录」；
  烧录通道走 **DSH Connection service**（桌面版页面靠 `__DSH_TRANSPORT__.streamBaseUrl` 解析宿主地址），不再用裸 WebSocket 猜 URL。
- 在官方语音输入设置里把输入设备选为 **Air remote (ESP32-C6)**；
- 首次使用先在设置页烧录内置固件（烧录按段写入，保留 NVS）。

## 开发板时间（时区设置）

设置页 → **开发板时间**：一个时区下拉（跟随系统 / UTC−8 洛杉矶 / UTC−5 纽约 / UTC+0 伦敦 /
UTC+1 柏林 / UTC+8 北京 / UTC+9 东京）、一个「同步到开发板」按钮，以及一个默认勾选的
**「自动对时（连上开发板就校准时间）」**开关。

- 手动点「同步到开发板」时，host 通过串口发两条命令：`AR1T <当前 UTC 秒>`（板载 RTC 只存 UTC）
  和 `AR1Z <偏移分钟>`（东为正，480 = UTC+8，存 NVS 的 `airremote_time` / `tz_min`）。
  板子两条都回 `OK` 才算成功；回 `ERR` 或超时按错误码上报。
- **自动对时**（默认开）：插件 host 启动 4 秒后、以及每次板子会话建立（页面连上 WSS 音频路由
  `/airremote/audio`）1.5 秒后，host 自己读 `time.json` 里的时区、算出分钟偏移，走同一套串口
  命令把时间写进板子——不需要用户点按钮。时区**只取自设置**，不硬编码浏览器时区；选「跟随系统」
  时用 host 运行环境的系统偏移（`-new Date().getTimezoneOffset()`）兜底。关掉开关后只剩手动按钮。
- 自动对时的节流与容错：同一次启动 / 同一次连接最多尝试一次，失败**不重试**、只 `logger.warn`
  一条「自动对时失败（不重试）…」；没找到板子、串口被烧录或手动同步占着、共享闸门正忙时
  直接跳过（记一条 info），不算错误。整个过程异步且 `try/catch` 包裹，`apply()` 只 `setTimeout`
  排期、**不 await**，所以串口慢或失败都不会拖慢 / 拖垮插件加载。
- 改下拉框只保存选择，不碰串口；改开关也只写 `time.json`（下一次启动 / 连接才生效）。
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
| GET | `/airremote/time` | 读取保存的时区选择与自动对时开关 |
| POST | `/airremote/time` | 保存时区选择 / 自动对时开关（可只传其中一项） |
| POST | `/airremote/sync-time` | 用串口把当前时间与时区写给板子 |
| GET | `/airremote/firmware/manifest` | 内置固件元数据（manifest 缺失 / 损坏时 503） |
| GET / HEAD | `/airremote/firmware/image` | 流式下发合并镜像，`application/octet-stream`，带 `Content-Length` / `ETag`；`If-None-Match` 命中回 304 |
| GET | `/airremote/serial-state` | 当前串口持有者 `{ holder: "none"\|"flash"\|"sync", since }` |
| POST | `/airremote/serial-hold` | 抢 / 放串口（`{"holder":"flash"}` 抢、`{"holder":"none"}` 放）；被烧录持有时 `/airremote/sync-time` 回 `{"ok":false,"error":"busy"}` |

响应都是 `application/json; charset=utf-8`；业务失败也是 HTTP 200，只有请求体不合法才 400。

`GET /airremote/time` → 200：

```json
{ "ok": true, "timezone": "auto", "autoSync": true, "updatedAt": "2026-11-11T05:44:00.000Z" }
```

`timezone` 未保存过时为 `"auto"`，`autoSync` 未保存过时为 `true`，`updatedAt` 未保存过时为 `null`。

`POST /airremote/time` 请求体 `{ "timezone": "auto" }`、`{ "autoSync": false }` 或两者都给：
`timezone` 为字符串、长度 1..32、只允许 `[a-z0-9+_-]`（大小写不敏感，统一存小写）；`autoSync`
必须是布尔值；两项至少给一个，只改给出的字段，另一个沿用文件里的值。合法 → 200 并返回与 GET
相同的结构（`updatedAt` 为本次写入时间）；不合法 → 400。

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

`unix` 取自 **host 的系统时钟**（`Math.floor(Date.now()/1000)`），不用浏览器时钟；手动同步与
自动对时共享一个「一次只写一次串口」的闸门，同一时刻只允许一次同步，第二次（含自动对时正在写时）
直接回 `busy`。

## 固件烧录

用数据线接入板子 → **设置 → Air remote → 固件烧录 → 扫描设备**。页面打开时不会自动扫描。确认端口和包内固件版本后点**开始烧录**，页面会显示进度与日志。

串口和 esptool-js 运行在 Windows DSH 宿主中，页面通过 DSH 的连接服务接收进度，不使用 Web Serial。宿主写入前核对镜像大小和 SHA-256，并与校时共用串口互斥。

### 版本和数据保留

- 插件版本见 [package.json](package.json)，内置固件版本和源码提交见 [manifest.json](firmware/manifest.json)。设置页显示的是**包内版本**；板上实际运行版本以启动日志 `App version` 为准。
- 本包按四段写入：`0x0` bootloader、`0x8000` 分区表、`0x10d000` OTA 数据、`0x200000` 应用；跳过 `0x9000–0x10cfff` 的 NVS，保留蓝牙配对、Wi-Fi 配网和时区。**不要把合并镜像从 `0x0` 整片写入。**
- 维护者烧录前备份 NVS；验收时核对烧前、烧后的 NVS 与蓝牙自动重连。

### 构建与校验

镜像只在开发机上构建；插件运行时不调用 ESP-IDF 或 Python。按[维护者指南](../../docs/plugin-install-and-publish.md#维护者从源码构建与打包)同步 Git、从干净固件源码构建，再显式传入固件版本（`--version X.Y.Z` 或 `AIRREMOTE_FIRMWARE_VERSION`）。打包脚本拒绝诊断构建、版本来源不符或跨越擦除边界的镜像，不回退到旧合并产物。

在本目录运行 `npm run check:firmware`，即可校验已内置镜像的 SHA-256、四段布局和 Git 来源；不需要连开发板。

## 数据目录

`%USERPROFILE%\.dsh\airremote\`：

- `pairing.txt`：固件 `pairing.txt` 的 64 字符 token（秘密）；
- `server.crt`：板子自签名证书（TLS pin；缺失则不校验）；
- `simulate`：存在即启用模拟板子；
- `sim.wav`：模拟板子循环的 16 kHz mono WAV；
- `time.json`：设置页「开发板时间」选的时区与自动对时开关，
  `{ "timezone": "auto", "autoSync": true, "updatedAt": "<ISO>" }`
  （原子写：先写 `time.json.tmp` 再 rename；缺失或损坏按 `auto` + 自动对时开启处理）。
- 固件**没有**缓存：内置镜像与 manifest 随插件包走（`plugins/dsh-airremote/firmware/`），运行时
  只读、流式下发，不往 `~/.dsh/airremote/` 写任何固件文件。

真实板子使用前先在板子上点 **Voice**，让板子进入语音会话并广播（`AR1V` 串口触发已从发布镜像移除）。

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
