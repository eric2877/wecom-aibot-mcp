# @vrs-soft/wecom-aibot-mcp

中文 | [English](README_EN.md)

企业微信智能机器人 MCP 服务 - Claude Code 远程审批通道

> 通过企业微信智能机器人实现 Claude Code 的远程审批和消息推送，离开电脑也能处理决策请求。

## 功能特性

- 🔐 **远程审批**：敏感操作通过微信卡片审批，支持"允许一次/拒绝"
- 💬 **双向通信**：任务进度、完成通知实时推送到微信
- 📱 **Headless 模式**：离开电脑时切换到微信交互，支持 HTTP 轮询和 Channel 推送两种模式
- 🚀 **Channel 模式**：微信消息自动唤醒 Claude agent，无需心跳轮询（需 claude.ai 直连账号）
- 🤖 **多机器人支持**：支持配置多个机器人，团队场景下多人独立使用
- 👥 **群聊支持**：支持群聊 @机器人，自动回复到正确的群聊会话
- 🌐 **双传输模式**：HTTP Transport（轮询）+ Channel MCP（SSE 推送）

## 架构

```
┌─────────────────┐    MCP (HTTP)     ┌──────────────────────┐
│  Claude Code    │ ───────────────▶  │  wecom-aibot-mcp     │
│  (HTTP MCP)     │ ◀───────────────  │  HTTP Server :18963  │
└─────────────────┘                   └──────────────────────┘
                                               │  ▲
                                          SSE  │  │ 消息推送
                                               ▼  │
┌─────────────────┐    stdio          ┌──────────────────────┐
│  Claude Code    │ ◀────────────▶    │  wecom-aibot-channel │
│  (Channel MCP)  │  notifications/   │  Channel Proxy       │
└─────────────────┘  claude/channel   └──────────────────────┘
                                               │
                                       WebSocket 长连接
                                               ↓
                                      ┌───────────────────┐
                                      │  企业微信服务器     │
                                      └───────────────────┘
                                               │
                                               ↓
                                      ┌───────────────────┐
                                      │  用户企业微信客户端  │
                                      │  (手机/桌面)        │
                                      └───────────────────┘
```

### 运行模式对比

| 特性 | Channel 模式 | HTTP 模式 |
|------|-------------|----------|
| 消息接收 | SSE 推送，自动唤醒 | `/loop` 心跳轮询 |
| 响应延迟 | 即时 | ≤1 分钟 |
| 账号要求 | claude.ai 直连登录 | API Key / 中转均可 |
| 启动方式 | `--dangerously-load-development-channels` | 普通启动 |

### 审批流程

```
Claude 请求执行敏感操作（Bash/Write/Edit 等）
              ↓
PermissionRequest Hook 拦截
              ↓
     ┌────────────────────────┐
     │ 检查 headless 模式状态  │
     └────────────────────────┘
              │
      ┌───────┴───────┐
      ↓               ↓
  非 headless      headless
      ↓               ↓
 终端确认框      发送微信审批卡片
                      │
                 用户点击按钮
                      │
              通过 HTTP /approval_status
                      ↓
              执行或拒绝操作
```

## 安装

### 前置要求

- **Node.js >= 18**
- 企业微信账号（有创建机器人权限）
- Claude Code

### 第一步：创建企业微信机器人

1. 登录企业微信管理后台：https://work.weixin.qq.com
2. 进入「管理工具」→「智能机器人」
3. 点击「创建机器人」→「手动创建」
4. 填写机器人名称（如"Claude 审批助手"）
5. 在「API 配置」区域：
   - 连接方式选择「**使用长连接**」
   - 点击「获取 Secret」
6. 记录 **Bot ID** 和 **Secret**

> ⚠️ 每个机器人同时只能保持一个 WebSocket 长连接

### 第二步：运行配置向导

```bash
npx @vrs-soft/wecom-aibot-mcp
```

配置向导会引导您：
1. 输入**机器人名称**（用于识别，如"工作机器人"）
2. 输入 **Bot ID**
3. 输入 **Secret**
4. 在企业微信中给机器人发送消息，自动识别用户 ID

配置完成后会自动：
- 写入机器人配置到 `~/.wecom-aibot-mcp/config.json`
- 写入双 MCP 配置到 `~/.claude.json`（HTTP + Channel）
- 注册 PermissionRequest hook 到 `~/.claude/settings.local.json`
- 安装 headless-mode skill
- 后台启动 MCP 服务

## 常用命令

| 命令 | 说明 |
|------|------|
| `npx @vrs-soft/wecom-aibot-mcp` | 首次配置向导 |
| `npx @vrs-soft/wecom-aibot-mcp --start` | 后台启动 MCP 服务 |
| `npx @vrs-soft/wecom-aibot-mcp --stop` | 停止 MCP 服务 |
| `npx @vrs-soft/wecom-aibot-mcp --status` | 查看状态 |
| `npx @vrs-soft/wecom-aibot-mcp --config` | 修改配置 |
| `npx @vrs-soft/wecom-aibot-mcp --add` | 添加新机器人 |
| `npx @vrs-soft/wecom-aibot-mcp --delete` | 删除机器人配置 |
| `npx @vrs-soft/wecom-aibot-mcp --clean-cache` | 清空 CC 注册表缓存 |
| `npx @vrs-soft/wecom-aibot-mcp --debug` | 前台启动（输出调试日志） |
| `npx @vrs-soft/wecom-aibot-mcp --uninstall` | 完全卸载 |

## 快速开始

### MCP 配置

配置向导自动写入 `~/.claude.json`（同时配置两种模式）：

```json
{
  "mcpServers": {
    "wecom-aibot": {
      "type": "http",
      "url": "http://127.0.0.1:18963/mcp"
    },
    "wecom-aibot-channel": {
      "command": "npx",
      "args": ["@vrs-soft/wecom-aibot-mcp", "--channel"]
    }
  }
}
```

### 启动 HTTP MCP 服务

```bash
npx @vrs-soft/wecom-aibot-mcp --start
```

### 启动 Channel 模式（研究预览）

Channel 模式需要 claude.ai 直连账号，启动时加参数：

```bash
claude --dangerously-load-development-channels server:wecom-aibot-channel
```

> **注意**：使用 API Key 或 API 中转服务时，Channel 模式不可用，请使用 HTTP 模式。

## 使用示例

### HTTP 模式（通用）

```
你：现在开始通过微信联系

Claude：已进入微信模式（HTTP），开始心跳轮询，等待消息中。
微信收到：【进度】已进入微信模式...

[你离开电脑，在微信发送消息]

微信发送：帮我查看一下服务器日志

Claude：收到，开始处理...
[执行操作，需要审批时发送微信卡片]

微信收到审批卡片：
┌─────────────────────────┐
│ 【待审批】Bash           │
│ 执行命令: tail -100 app.log│
│ [允许一次] [拒绝]        │
└─────────────────────────┘

Claude：微信收到结果通知
```

### Channel 模式（自动唤醒）

```bash
# 以 Channel 模式启动
claude --dangerously-load-development-channels server:wecom-aibot-channel
```

```
你：现在开始通过微信联系（Channel 模式）

Claude：已进入微信模式（Channel），消息将通过 SSE 自动推送。

[发送微信消息后，Claude 自动被唤醒，无需轮询等待]
```

### 群聊支持

将机器人拉入群聊，在群中 @机器人：

```
群聊中：
张三：@Claude助手 查看最新代码提交

Claude：[自动识别群聊 ID，回复到同一群聊]
收到，查看最新提交...
```

## MCP 工具

### HTTP MCP（wecom-aibot）

| 工具 | 说明 | 参数 |
|------|------|------|
| `enter_headless_mode` | 进入微信模式 | `cc_id`, `robot_id`, `mode`, `project_dir` |
| `exit_headless_mode` | 退出微信模式 | `cc_id`, `project_dir` |
| `send_message` | 发送消息到微信 | `cc_id`, `content`, `target_user` |
| `get_pending_messages` | 获取待处理消息（长轮询） | `cc_id`, `timeout_ms` |
| `heartbeat_check` | 心跳检查（HTTP 模式） | - |
| `update_heartbeat_job_id` | 保存心跳 job ID | `cc_id`, `job_id` |
| `check_connection` | 检查连接状态 | - |
| `list_robots` | 列出所有机器人 | - |
| `get_connection_stats` | 获取连接统计 | `recent_logs` |
| `detect_user_from_message` | 从消息识别用户 | `timeout` |
| `get_setup_requirements` | 获取配置需求 | - |
| `get_setup_guide` | 获取安装指南 | - |
| `add_robot_config` | 添加机器人配置 | `name`, `bot_id`, `secret` |

### Channel MCP（wecom-aibot-channel）

同 HTTP MCP 工具列表，所有调用转发到 HTTP MCP，另额外建立 SSE 连接实现推送唤醒。

## 配置说明

### 多机器人配置

支持多个机器人独立使用：

```json
// ~/.wecom-aibot-mcp/config.json（默认机器人）
{
  "botId": "bot-xxx",
  "secret": "sec-yyy",
  "targetUserId": "user1",
  "nameTag": "机器人1"
}

// ~/.wecom-aibot-mcp/robot-1234567890.json（额外机器人）
{
  "botId": "bot-zzz",
  "secret": "sec-www",
  "targetUserId": "user2",
  "nameTag": "机器人2"
}
```

### 超时审批配置

在机器人配置文件中可配置审批超时时间：

```json
{
  "autoApproveTimeout": 600
}
```

- `autoApproveTimeout`: 审批超时（秒），默认 600 秒（10 分钟）
- 超时后，项目目录内的操作自动允许，项目外自动拒绝

### 拆分部署（远程 HTTP + 本地 Channel）

HTTP MCP 运行在远程服务器，Channel MCP 代理运行在本地：

```bash
# 远程服务器
npx @vrs-soft/wecom-aibot-mcp --http-only --start

# 本地机器
MCP_URL=http://远程IP:18963 npx @vrs-soft/wecom-aibot-mcp --channel-only
```

## 故障排查

### Channels 不可用

```
Channels are not currently available
```

原因：使用 API Key 或 API 中转服务，不支持 Channel 模式。

解决：切换到 claude.ai 直连账号，或使用 HTTP 模式（功能等价）。

### 认证失败（错误码 40058）

1. 新建机器人需等待约 2 分钟同步
2. 完成授权：机器人详情 → 可使用权限 → 授权
3. 检查 Bot ID 和 Secret 是否正确

### 连接问题

```bash
# 检查服务状态
curl http://127.0.0.1:18963/health

# 清空 CC 注册表缓存（断线残留）
npx @vrs-soft/wecom-aibot-mcp --clean-cache

# 查看调试日志
npx @vrs-soft/wecom-aibot-mcp --debug

# 重启服务
npx @vrs-soft/wecom-aibot-mcp --stop
npx @vrs-soft/wecom-aibot-mcp --start
```

### 完全卸载

```bash
npx @vrs-soft/wecom-aibot-mcp --uninstall
```

这会删除：
- `~/.wecom-aibot-mcp/`
- `~/.claude.json` 中的 wecom-aibot 配置
- `~/.claude/settings.local.json` 中的 hook
- `~/.claude/skills/headless-mode/`

## 开发

```bash
git clone https://github.com/eric2877/wecom-aibot-mcp.git
cd wecom-aibot-mcp
npm install
npm run build
```

## License

MIT

## 相关链接

- [企业微信智能机器人文档](https://developer.work.weixin.qq.com/document/path/101039)
- [Claude Code Channels 文档](https://code.claude.com/docs/en/channels-reference)
- [MCP 协议规范](https://modelcontextprotocol.io)
