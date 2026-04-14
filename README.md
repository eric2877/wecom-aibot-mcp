# @vrs-soft/wecom-aibot-mcp

中文 | [English](README_EN.md)

企业微信智能机器人 MCP 服务 - 让 Claude Code 通过微信远程审批和交互。

## 功能

- 远程审批敏感操作（Bash/Write/Edit），微信卡片一键通过/拒绝
- 离开电脑后通过微信下达任务，实时接收进度通知
- 支持 Channel 模式（SSE 推送唤醒）和 HTTP 模式（心跳轮询）
- 支持群聊 @机器人，自动回复到对应会话
- 支持多机器人、多用户

## 安装

```bash
npx @vrs-soft/wecom-aibot-mcp
```

首次运行进入配置向导，完成后自动启动服务并写入 Claude Code MCP 配置。

**前置条件**：企业微信管理后台创建智能机器人，连接方式选「使用长连接」，记录 Bot ID 和 Secret。

## 启动服务

```bash
# 后台启动（常用）
npx @vrs-soft/wecom-aibot-mcp --start

# Channel 模式（需 claude.ai 直连账号）
claude --dangerously-load-development-channels server:wecom-aibot-channel
```

## 常用命令

| 命令 | 说明 |
|------|------|
| `--start / --stop` | 启动/停止后台服务 |
| `--status` | 查看服务状态和机器人列表 |
| `--config` | 修改默认机器人配置 |
| `--add / --delete` | 添加/删除机器人 |
| `--set-token [token]` | 设置 Auth Token（远程部署用） |
| `--set-token --clear` | 清除 Auth Token |
| `--debug` | 前台启动，输出调试日志 |
| `--clean-cache` | 清空 CC 注册表缓存 |
| `--upgrade` | 强制升级全局配置 |
| `--uninstall` | 完全卸载 |

## 运行模式

| | Channel 模式 | HTTP 模式 |
|-|-------------|----------|
| 消息接收 | SSE 自动推送唤醒 | `/loop` 心跳轮询 |
| 响应延迟 | 即时 | ≤1 分钟 |
| 账号要求 | claude.ai 直连 | 任意（含 API 中转）|

使用微信模式时告诉 Claude「现在开始通过微信联系」，会自动触发 `headless-mode` skill。

## 配置说明

机器人配置保存在 `~/.wecom-aibot-mcp/`，支持多个机器人并发：

```bash
npx @vrs-soft/wecom-aibot-mcp --add   # 添加机器人
npx @vrs-soft/wecom-aibot-mcp --status # 查看占用情况
```

超时自动审批（默认 10 分钟）：在机器人配置中设置 `"autoApproveTimeout": 600`。

## 故障排查

```bash
# 检查服务
curl http://127.0.0.1:18963/health

# Channel 不可用（"Channels are not currently available"）
# → 使用 API Key 或中转服务，改用 HTTP 模式

# 端口占用
lsof -i :18963 | grep LISTEN   # 找到 PID
kill <PID>

# 清理断线残留
npx @vrs-soft/wecom-aibot-mcp --clean-cache
```

## 拆分部署

HTTP MCP Server 和 Channel MCP 分开安装在不同机器：

```bash
# 远程服务器（只安装 HTTP MCP Server）
npx @vrs-soft/wecom-aibot-mcp --set-token your-secret-token
npx @vrs-soft/wecom-aibot-mcp --http-only --start

# 本地（只安装 Channel MCP）
npx @vrs-soft/wecom-aibot-mcp
# → 选择 2：远程服务器（连接远程 HTTP MCP）
# → 选择 2：Channel MCP（推荐）
# → 输入服务器 URL：https://your-server:18963
# → 输入 Auth Token：your-secret-token

# 启动 Channel MCP
claude --dangerously-load-development-channels server:wecom-aibot-channel
```

**安装模式对比**：

| 模式 | 本地安装内容 | Auth Token |
|------|-------------|-----------|
| 本地安装（选项 1） | HTTP Server + Channel MCP | 不需要 |
| 远程服务器 → 仅 HTTP | 无（用 HTTP 模式轮询） | 必填 |
| 远程服务器 → Channel | Channel MCP | 必填 |

**Auth Token 说明**：
- 仅在拆分部署场景需要（HTTP Server 和 Channel 分开安装）
- `/health` 端点豁免校验（供负载均衡探测）
- Token 同时写入服务端 `server.json` 和客户端 MCP 配置的 `env.MCP_AUTH_TOKEN`

## License

MIT · [企业微信机器人文档](https://developer.work.weixin.qq.com/document/path/101039) · [Channels 文档](https://code.claude.com/docs/en/channels-reference)
