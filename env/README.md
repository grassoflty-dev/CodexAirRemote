# env/ — 环境配置（不属于工程）

本目录只放开发环境（ESP-IDF、工具链），**不参与固件编译、不提交到 git**。

## 内容与来源

| 路径 | 内容 | 版本/来源 |
| --- | --- | --- |
| `env/esp-idf/` | ESP-IDF | v5.5.5，复制自 `C:\Espressif-AirRemote\v5.5.5\esp-idf` |
| `env/tools/` | Espressif 工具链（riscv32-esp-elf、python venv、esptool、openocd 等） | 复制自 `C:\Espressif\tools`（EIM 安装） |
| `env/eim_idf.json` | EIM 配置，指向本目录 | 本仓库生成 |

## 克隆后如何准备

方式一（推荐，已装 EIM 的机器）：把本机 ESP-IDF 5.5.5 与 tools 复制到 `env/`：

```powershell
robocopy "C:\Espressif-AirRemote\v5.5.5\esp-idf" "E:\path\to\repo\env\esp-idf" /E
robocopy "C:\Espressif\tools" "E:\path\to\repo\env\tools" /E
```

方式二（离线包）：把 EIM 的 ESP-IDF 5.5.5 离线安装包解压到 `env/esp-idf` 与 `env/tools`，再按 `env/eim_idf.json` 修改路径。

## 命令行构建

```powershell
$env:IDF_PATH      = "$PWD\env\esp-idf"
$env:IDF_TOOLS_PATH = "$PWD\env\tools"
& "$env:IDF_TOOLS_PATH\python\v5.5.5\venv\Scripts\python.exe" "$env:IDF_PATH\tools\idf.py" -C firmware build
```

或使用 VS Code 的 ESP-IDF 扩展：打开 `firmware/` 作为工程，把 `idf.eimIdfJsonPath` 指向 `env/eim_idf.json`，`idf.currentSetup` 选择 env 的 setup。

## 注意

- `env/` 已加入 `.gitignore`（体积大、与本机路径相关）。
- 升级 IDF/工具链时同时更新本文件与 `docs/firmware-audit.md`。
