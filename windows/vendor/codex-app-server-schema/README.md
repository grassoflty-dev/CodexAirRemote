# Codex app-server 协议 schema（参考副本）

本目录是开发期间从本机 Codex 桌面版/CLI 导出并整理的 **Codex app-server JSON-RPC 协议**
schema，仅用于查阅 `windows/host/codex_adapter.py` 里用到的消息结构：

- `codex_app_server_protocol.schemas.json`：v1 协议总 schema
- `codex_app_server_protocol.v2.schemas.json`：v2 协议总 schema
- 其余 `*.json`：按消息拆分的单个 schema（`ClientRequest`、`ServerNotification`、
  `TurnCompletedNotification` 等）
- `v1/`、`v2/`：按版本归档的拆分文件

说明：

- 这些文件**不参与运行**，辅助程序运行时只通过 stdio 与本机 `codex app-server` 通信，
  不读取本目录。保留它们是为了方便核对 `codex_adapter.py` 中的方法名与参数
  （`initialize`、`account/read`、`thread/start`、`thread/resume`、`turn/start`、
  `turn/completed`）。
- 协议版权归 OpenAI，随 Codex 版本变化；升级 Codex 后应重新导出并核对。
- 如果不需要协议对照，可以安全地整个删除本目录（不会影响构建与运行）。
