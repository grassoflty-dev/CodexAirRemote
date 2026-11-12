# 安装与发布（DSH 插件 + 固件一体化包）

本包把 **固件镜像、烧录入口、时区/自动对时、语音直连** 打成一个 DSH 插件：
安装插件后，在 DSH 设置页即可完成「烧录固件 → 设置开发板时间」，不需要另装工具。

- 仓库：<https://github.com/grassoflty-dev/CodexAirRemote>（**public**）
- 插件目录：`plugins/dsh-airremote`
- 插件版本：`0.3.0`；内置固件：`0.5.0`（`plugins/dsh-airremote/firmware/manifest.json`）
- 授权：插件 MIT，仓库与固件 Apache-2.0（见 `LICENSE` / `firmware/LICENSE`）

## 1. 前置条件

| 条件 | 说明 |
| --- | --- |
| DSH | `>= 0.2.0-rc.1` |
| 插件市场（Discover） | 需启用实验性 bundle `@deepseek-ai/dsh-experimental-plugin-market-bundle`；未启用时可用「方式二」直接安装 |
| 浏览器 | 烧录需要 Chromium 内核 + 安全上下文（`https://` 或 `localhost`），并授予串口权限 |
| 开发板 | ESP32-C6-Touch-AMOLED-2.16（CH343/内置 USB 串口均可） |

## 2. 从插件索引安装（可被其他人搜到）

1. DSH → **Plugins → Discover** → **Add index source**；
2. 输入索引文件 URL：

   ```text
   https://raw.githubusercontent.com/grassoflty-dev/CodexAirRemote/main/plugin-index.json
   ```

3. 搜索 **Air Remote** / `dsh-airremote` → **Install** → **Installed** 里启用；
4. 设置页会出现 **Air Remote** 面板：烧录固件、设置开发板时间（时区）、语音设备状态。

索引格式为 DSH 的 *plugin market index format 1*（`format: 1` + `plugins[]`），
每个版本的 `source` 是 `{type: "git", url, commit, path}`；DSH 会把它拼成
`git+https://github.com/grassoflty-dev/CodexAirRemote.git#<commit>&path:/plugins/dsh-airremote`
交给 pnpm 安装。`firmware/manifest.json` 与索引里的版本号/commit 必须同时更新。

## 3. 直接安装（不走索引）

```text
plugin_manager install_bundle  git+https://github.com/grassoflty-dev/CodexAirRemote.git#<40位commit>&path:/plugins/dsh-airremote
```

或走安全启动器端点（推荐，带兼容性金丝雀）：

```text
POST http://127.0.0.1:3080/dsh-safe-launch/install-plugin
{"source": "git+https://github.com/grassoflty-dev/CodexAirRemote.git#<40位commit>&path:/plugins/dsh-airremote"}
```

## 4. 发布/更新流程（维护者）

```powershell
# 1) 构建固件并一键生成合并镜像 + manifest（版本号按语义化递增）
. .\env\activate.ps1
idf -C firmware build
node plugins/dsh-airremote/scripts/bundle-firmware.mjs --version 0.5.0

# 2) 插件版本与镜像版本同步
cd plugins/dsh-airremote
npm run build
npm version patch   # 或手工改 package.json（插件版本与固件版本是两套号）

# 3) 更新仓库根 plugin-index.json：
#    - plugins[0].versions[0].version = 插件版本
#    - source.commit = 本次提交的 40 位 commit
#    - publishTimestamp = 当前 Unix 秒
# 4) 提交 → push main（索引 URL 走 main，push 后即可被 Discover 读到）
```

## 5. 常见问题

- **Discover 里搜不到**：确认索引 URL 可访问（`main` 分支）、DSH 版本满足、仓库是 public；
  索引文件里 `format` 必须为 `1`，`plugins[].versions[].source.commit` 必须是 40 位小写 SHA。
- **安装后设置页没有 Air Remote 面板**：到 Plugins → Installed 启用插件并重载 DSH；
  客户端 bundle 需要 web profile 重载一次。
- **烧录失败**：先确认串口未被其他程序占用（插件内 `SerialHolder` 会拒绝重复占用）；
  烧录会清 NVS，Wi-Fi 配网与时区需要重设。
- **固件与插件版本**：插件版本（`package.json`）与内置固件版本（`firmware/manifest.json`）独立，
  固件更新后必须重新打包镜像并同步 `plugin-index.json`。
