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

### 方式一：从 DSH 插件索引安装（Discover，推荐）

要求：DSH `>= 0.2.0-rc.1`，且已启用实验性插件市场 bundle
`@deepseek-ai/dsh-experimental-plugin-market-bundle`（提供 **Plugins → Discover** 标签页）。

1. 打开 **Plugins → Discover**，点 **Add index source**（添加索引源）；
2. 填入本仓库的索引地址：

   ```text
   https://raw.githubusercontent.com/grassoflty-dev/CodexAirRemote/main/plugin-index.json
   ```

3. 在 Discover 里搜索 **Air Remote**（或 `dsh-airremote`），点 **Install**；
4. 安装完成后到 **Plugins → Installed** 启用 `dsh-airremote`，重启 DSH 或按提示重载。

索引里的每个版本都指向本仓库的一个固定 commit（`git+https://…&path:/plugins/dsh-airremote`），
安装的是该 commit 的源码包；仓库已提交构建好的 `lib/`，所以安装时不需要在本地重新编译。

### 方式二：直接安装（指定 commit）

```text
plugin_manager install_bundle  git+https://github.com/grassoflty-dev/CodexAirRemote.git#<40位commit>&path:/plugins/dsh-airremote
```

把它交给 DSH 的插件管理入口（或用安全启动器的 install-plugin 端点），**不要手工改 profile**。
`plugin-index.json` 里的 `source.commit` 就是当前可用的 commit。

### 本地开发安装（改代码时）

```powershell
cd plugins/dsh-airremote
npm install
npm run check
npm run build
```

然后：

```text
plugin_manager install_bundle  link:D:\C-Develop\CodexAirRemote\plugins\dsh-airremote
plugin_manager set_bundle      @deepseek-ai/dsh-experimental-voice-input-bundle  enabled=true
```

在官方语音输入设置里把输入设备选为 **Air Remote (ESP32-C6)**。

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

设置页 → **固件烧录**（`settings.section`，id `airremote-firmware`）：把插件包里内置的合并镜像
通过浏览器 **Web Serial** 写进开发板。host 不碰串口，只按静态文件把镜像流式下发。

- 面板先读 `GET /airremote/firmware/manifest`，显示内置固件：版本 `v0.4.0`、构建时间 `builtAt`
  （`2026-11-11T07:44:00.992Z`）、大小 `size`（`4,576,896` 字节 ≈ 4.36 MB）、`sha256` 前 8 位
  （`52924131`，悬停可见完整值）、芯片 `esp32c6`。
- 「选择串口」调 `navigator.serial.requestPort({ filters: [{ usbVendorId: 0x303a }] })`，只列
  Espressif（VID `303A`）设备；选中后显示 VID / PID。
- 「烧录」是一次显式点击，流程是：
  1. 下载 `GET /airremote/firmware/image`（合并镜像）；
  2. 浏览器端用 `crypto.subtle.digest('SHA-256', …)` 算摘要（同时核对字节数），与 manifest 比对，
     不一致直接中止（「固件文件损坏（sha256 不匹配）」），**此时还没碰串口**；
  3. `window.confirm` 二次确认：版本、sha256 前 8 位、芯片，并写明会清除 Wi-Fi 配网与时区；
  4. `POST /airremote/serial-hold` 带 `{"holder":"flash"}` 抢串口；被 `sync` 占着时回 `busy` 并中止；
  5. 动态 import esptool-js，`new Transport(port, true)` + `new ESPLoader({ baudrate: 460800 })`，
     `loader.main()` 读出芯片描述，不是 ESP32-C6 系列立即中止；
  6. `loader.writeFlash()`：offset **0x0**、`flashSize` / `flashMode` / `flashFreq` 全 `keep`、
     `compress: true`；面板上的「擦除整片」默认**关闭**，勾选才传 `eraseAll: true`；
  7. 进度条取 `reportProgress`（百分比 + 已写 / 总数），下方日志框保留最近 **200 行** esptool 输出；
  8. 失败时状态行给具体原因（超时 / 串口掉线 / 不是 C6 / busy 等）和「重试」按钮；串口掉线会清掉
     已选端口，重试先重新选口；
  9. 收尾发 `loader.after('hard_reset')` 硬复位；`finally` 里先关浏览器侧串口（5 秒超时兜底），
     再 `POST /airremote/serial-hold {"holder":"none"}` 释放，异常路径也不会把板子锁住。

### 两套版本号：插件版本 ≠ 固件版本

- **插件版本**：`plugins/dsh-airremote/package.json` 的 `version`（当前 `0.2.0`）。指插件**自身**
  （host / client / 路由）的版本，按 npm 包语义演进，`npm install` 与插件管理安装看的是它。
- **固件版本**：`plugins/dsh-airremote/firmware/manifest.json` 的 `version`（当前 `0.4.0`）。指**随包
  内置的 ESP32-C6 固件**版本，显示在设置页「固件烧录 / 固件 v0.4.0」，烧录前的 sha256 校验和二次确认
  用的也是它。
- 两者**故意解耦**：改插件代码不动固件版本，重打固件也不动插件版本，各自独立演进。所以打新固件时
  务必用 `--version` 显式给固件版本（见下文），别拿 `package.json` 的插件版本当固件版本。

### 前提：Chromium 内核 + 安全上下文

- Web Serial 只在 **Chromium 内核**（Chrome / Edge）且**安全上下文**下可用。`http://127.0.0.1:57648`
  满足安全上下文，用 Chrome/Edge 直接打开即可。
- **DSH 桌面（Electron）窗口禁用了 Web Serial**：`app.asar` 的 `lib/main.js` 里有
  `setDevicePermissionHandler(() => false)`，桌面窗口拿不到 `navigator.serial`。所以在桌面窗口里
  打开设置页会看到降级提示（「当前环境不支持 Web Serial…」）、「选择串口」置灰——这是预期行为，
  不是故障。**要烧录请用 Chrome/Edge 打开同一个地址。**
- 环境缺 WebCrypto 时也会禁用烧录（sha256 校验做不了）。

### 副作用：会清掉 NVS，即 Wi-Fi 配网与时区

合并镜像从 **0x0** 整体写入（bootloader / 分区表 / ota_data / app 全在里面），**会覆盖 nvs 分区**，
也就是**清除开发板上的 Wi-Fi 配网与时区设置**——这是镜像布局决定的，不是可选项。烧完必须：

1. 重新配网（本插件暂不提供配网 UI，见「状态」表里的 M4）；
2. 时间：自动对时开着（默认）时，烧完连上开发板的第一次会话就会自动补写时间和时区；关掉开关的话
   回到「开发板时间」再点一次「同步到开发板」。

### 内置镜像怎么来的（开发侧，运行时绝不调用）

`firmware/codex_air_remote-merged.bin` 与 `firmware/manifest.json` 都在开发机上生成，插件运行时
只读这两个文件，**不会**调用 `idf` / `esptool` / python。

```powershell
idf -C firmware build
cd plugins/dsh-airremote
node scripts/bundle-firmware.mjs --version 0.4.0   # 打固件时显式给固件版本
```

版本号不再有脚本内置默认值，来源优先级：`--version <semver>` > 环境变量
`AIRREMOTE_FIRMWARE_VERSION` > `plugins/dsh-airremote/package.json` 的 `version`（即插件版本）。
三者都没有就报错退出；只想确认取到哪个版本、不生成镜像，可加 `--print-version`。
注意兜底来源是**插件版本**（`0.2.0`），与固件版本别混用（见「两套版本号」），发布固件请按上面显式给版本。

脚本做的事：跑 `idf -C firmware merge-bin`（失败回落到 `python -m esptool merge_bin`），把
`firmware/build/merged-binary.bin`（`4,576,896` 字节）拷成
`plugins/dsh-airremote/firmware/codex_air_remote-merged.bin`，再写 `manifest.json`
（`size` / `sha256` / `builtAt` / `version` / `commit` / `chip` / `flashOffset`）。
合并偏移以 `firmware/build/flash_args` 为准：`0x0` bootloader、`0x8000` partition-table、
`0x10d000` ota_data_initial、`0x200000` app。

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
