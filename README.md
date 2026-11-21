# Codex Air Remote

把微雪 **ESP32-C6-Touch-AMOLED-2.16** 变成 DeepSeek Harness（DSH）的无线语音输入设备和蓝牙空中鼠标。开发板经局域网 TLS/WSS 把麦克风音频送到 DSH；插件将音频交给 DSH 官方语音输入，转写结果进入会话草稿。USB 用于烧录和校时，不需要 VB-CABLE 或旧 Windows 辅助程序。

## 安装和烧录

1. 在 DSH **Plugins → Discover → Add index source** 添加以下地址，再搜索 `dsh-airremote` 安装。没有 Discover 时可用 **Plugins → Add plugin** 安装本地 `.tgz`。
   ```text
   https://raw.githubusercontent.com/grassoflty-dev/CodexAirRemote/main/plugin-index.json
   ```
2. 在 **Plugins → Installed** 确认插件启用。用数据线连接板子，打开 **设置 → Air remote**，点击**扫描设备**。确认目标板与内置固件版本后再烧录。
3. 在同一页可设置开发板时间与时区。固件分四段写入，保留 NVS 中的蓝牙配对、Wi-Fi 配网和时区。不要将合并镜像从 `0x0` 整片写入。

**Discover 当前为插件 `0.5.5` / 固件 `0.7.2`。** Git `main` 中是 `0.5.7` / `0.7.3`；`0.7.3` 虽针对旋转卡死做了修正，但真机仍报告旋转后上下错位，尚未提升至索引。具体状态、安装条件及版本对应关系见[安装与发布指南](docs/plugin-install-and-publish.md)。

## 仓库结构

| 目录 | 内容 |
| --- | --- |
| [DSH 插件](plugins/dsh-airremote/README.md) | USB 烧录及校时、板端语音直连、虚拟麦克风；分发包内含预构建插件代码与固件镜像 |
| [ESP32-C6 固件](firmware/README.md) | 板级驱动、480×480 触屏 UI、待机时钟、BLE HID 鼠标、语音通道；使用 ESP-IDF 5.5.5 |
| [开发进度](docs/开发进度.md) | 当前状态、真机验证和历史故障记录 |
| [旧 Windows 辅助程序](windows/README.md) | **已退役**，保留历史源代码，不参与当前构建、安装或配网流程 |

`firmware/` 是唯一活动固件，面向 **ESP32-C6、16 MB Flash、SH8601 480×480 AMOLED、CST9217 触摸**。引脚和迁移记录见 [C6 迁移说明](docs/firmware-c6-migration.md)。S3 工程不随仓库分发。

## 开发与发布

两台电脑通过 GitHub 同步。开工先按[仓库约定](AGENTS.md)同步 `origin/main`，再构建；不要把本机诊断构建作为发布镜像。

```powershell
# 已配置本机 ESP-IDF 5.5.5；在仓库根目录运行
. .\env\activate.ps1
idf -C firmware build

# 校验仓库当前内置镜像，无需烧录
npm --prefix plugins/dsh-airremote run check:firmware
```

完整流程（构建、打包、真机验收和更新索引）见[维护者指南](docs/plugin-install-and-publish.md#维护者从源码构建与打包)。[开发环境说明](docs/development-environment.md)记录了 ESP-IDF 及工具来源。构建缓存、串口日志、凭据和板上数据备份不随包分发。

## 许可证

仓库与固件采用 [Apache-2.0](LICENSE)，插件采用 [MIT](plugins/dsh-airremote/LICENSE)。第三方组件按其原许可证分发，见[第三方声明](THIRD_PARTY_NOTICES.md)。本项目与 OpenAI、乐鑫、微雪或 DeepSeek 无隶属关系。
