# 安装与发布 Air Remote

Air Remote 是一个 DSH 插件，包含 ESP32-C6 固件、USB 烧录、开发板时间/时区设置和语音直连。适用于微雪 **ESP32-C6-Touch-AMOLED-2.16**；当前串口烧录路径在 Windows DSH 宿主运行，不使用浏览器 Web Serial，也不用安装旧 Windows 辅助程序。

## 当前版本

| 来源 | 插件 | 固件 | 状态 |
| --- | --- | --- | --- |
| [DSH Discover 索引](../plugin-index.json) | `0.5.5`（`d9a0d42`） | `0.7.2` | 已发布；有真机验收记录，但设定页旋转后来复现过卡死 |
| Git `main` 中的[插件](../plugins/dsh-airremote/package.json)及[内置镜像](../plugins/dsh-airremote/firmware/manifest.json) | `0.5.7`（`1543316`） | `0.7.3`（`49e5257`） | 修复针对旋转卡死；用户在真机上报告旋转后持续上下错位，**不提升为 Discover 默认版本** |

插件版本、Git 安装定位提交与内置固件的源码提交是三个不同的值。设置页显示包内固件版本，并不代表板上已烧入该版本；需要时用板端启动日志的 `App version` 核对。

## 安装与使用

1. 在 DSH 的 **Plugins → Discover → Add index source** 添加：
   `https://raw.githubusercontent.com/grassoflty-dev/CodexAirRemote/main/plugin-index.json`。
   Discover 需要实验性插件市场；没有 Discover 时，可用 **Plugins → Add plugin** 安装指定版本的本地 `.tgz`。
2. 搜索 `dsh-airremote`，安装后在 **Installed** 确认已启用。更新时若遇到 `@serialport/bindings-cpp` 的 `EPERM`，检查是否还有宿主进程占用文件；不要手改 profile 或把半安装视为成功。更新后的版本需要重新启动 DSH 才能验证。
3. 用数据线连接开发板，打开 **设置 → Air remote**，按需点**扫描设备**。确认板型和目标版本后再烧录；时间与时区也在同一个设置页设置。

当前包按四段写入 `0x0`（bootloader）、`0x8000`（分区表）、`0x10d000`（OTA 数据）、`0x200000`（应用）。不覆盖 `0x9000–0x10cfff` 的 NVS；合并镜像只是四段数据的容器，**不能拿来从 `0x0` 整片写入**。维护者真机烧录前必须备份 NVS。

## 维护者：从源码构建与打包

1. 按仓库约定同步 `origin/main`；提交待发布的固件源码。使用干净提交、ESP-IDF 5.5.5 和全新构建产物，不把诊断补丁混入发布版。
2. 在仓库根目录执行（把 `X.Y.Z` 换成实际固件版本）：
   ```powershell
   . .\env\activate.ps1
   idf -C firmware build
   node plugins/dsh-airremote/scripts/bundle-firmware.mjs --version X.Y.Z
   node plugins/dsh-airremote/scripts/bundle-firmware.mjs --check
   ```
   打包工具检查四段布局和擦除边界，对比 app 内嵌的 Git 版本与源码 `HEAD`，重新生成合并镜像，不复用旧 `merged*.bin`。只核对已随包提交的镜像时用 `--check`，无需构建或连接板子。
3. 若改了插件或换了内置镜像，更新插件自己的版本及 lockfile。在[插件目录](../plugins/dsh-airremote/)运行 `npm ci`、`npm run check`、`npm run build`、`npm test`；`npm pack --dry-run` 核对包中有 `lib`、patch、图标、语言资源、详情页、固件镜像和清单，再用 `npm pack` 生成测试包。Git 安装依赖已经提交的 `lib` 与固件文件。
4. 用候选包真机验证扫描、分段烧录、启动版本、NVS 保留、设置页四向旋转、待机唤醒和 BLE 重连。旋转不能只看“未卡死”，还要确认切换后画面和触摸位置持续正确。
5. 验收通过后，先确定包含完整插件包的 Git 提交，再在[索引](../plugin-index.json)头部新增版本：`source.commit` 填该**插件包提交**的 40 位 SHA（不是固件源码提交）；`source.path` 保持 `plugins/dsh-airremote`，`publishTimestamp` 为发布 Unix 秒。确认发布授权后再推送插件包、索引与对应标签。

详见[插件说明](../plugins/dsh-airremote/README.md)、[固件工程](../firmware/README.md)和[真机记录](开发进度.md)。
