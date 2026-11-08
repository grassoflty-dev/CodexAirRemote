# 共享开发工具（Windows 全局）

本目录只放**不随两个项目源码分发**、但本机开发需要的小型工具。绝大多数 Windows 全局组件
（Python、ESP-IDF、VS Code 扩展、VB-CABLE）安装在本机全局位置，清单见
[../docs/components.md](../docs/components.md)。

## `eim/eim.exe`

- Espressif IDF Installation Manager（EIM）命令行，用来安装/切换 ESP-IDF 版本。
- 本机 ESP-IDF 5.5.5 安装在 `C:\Espressif-AirRemote\v5.5.5\esp-idf`，工具链在
  `C:\Espressif\tools`。EIM 的安装记录文件是 `C:\Espressif-AirRemote\eim_idf.json`，
  其中 `eimPath` 已指向本目录的 `eim.exe`。
- 该文件是二进制安装器，已加入 `.gitignore`，不随仓库提交。换机器时可以用官方 EIM
  安装器重新安装并更新 `eim_idf.json`。

常用命令（PowerShell）：

```powershell
# 查看已安装的 IDF 版本
.\tools\eim\eim.exe list

# 选择要激活的版本（会同步给 VS Code 的 ESP-IDF 扩展）
.\tools\eim\eim.exe select v5.5.5
```

## 与两个项目的关系

- `firmware/Build.ps1`、`firmware/Idf.ps1` 通过全局激活脚本
  `C:\Espressif\tools\Microsoft.v5.5.5.PowerShell_profile.ps1` 设置 `IDF_PATH`、
  `IDF_PYTHON_ENV_PATH` 和工具链 PATH，不依赖本目录。
- `firmware/.vscode/settings.json` 里 `idf.eimIdfJsonPath` 指向
  `C:\Espressif-AirRemote\eim_idf.json`，`idf.currentSetup` 指向 5.5.5 的 esp-idf 目录。
