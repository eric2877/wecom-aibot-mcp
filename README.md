# @vrs-soft/wecom-aibot-mcp

企业微信智能机器人 MCP 服务 - Claude Code 远程审批通道

> 通过企业微信智能机器人实现 Claude Code 的远程审批和消息推送，离开电脑也能处理决策请求。

## 功能特性

- 🔐 **远程审批**：敏感操作通过微信卡片审批，支持"允许一次/拒绝"
- 💬 **双向通信**：任务进度、完成通知实时推送到微信
- 📱 **Headless 模式**：离开电脑时切换到微信交互，长轮询实时接收消息
- 🤖 **多机器人支持**：支持配置多个机器人，团队场景下多人独立使用
- 🌐 **HTTP Transport**：使用 HTTP 传输，支持多实例共享服务

## 架构

```
┌─────────────────┐      MCP (HTTP)       ┌──────────────────┐
│  Claude Code    │  ──────────────────▶  │  wecom-aibot-mcp │
│  (MCP Client)   │  ◀──────────────────  │  MCP Server      │
└─────────────────┘                       └──────────────────┘
                                                   │
                                           WebSocket 长连接
                                                   ↓
                                          ┌───────────────────┐
                                          │  企业微信服务器     │
                                          │  wss://openws...   │
                                          └───────────────────┘
                                                   │
                                                   ↓
                                          ┌───────────────────┐
                                          │  用户企业微信客户端  │
                                          │  (手机/桌面)        │
                                          └───────────────────┘
```

### 审批流程

```
Claude 请求执行敏感操作（Bash/Write/Edit 等）
              ↓
PermissionRequest Hook 拦截
              ↓
     ┌────────────────────────┐
     │ 检查 headless 模式状态  │
     │ (检查 .claude/headless.json)
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

### Headless 模式

```
用户：现在开始通过微信联系
  ↓
Claude → enter_headless_mode()
  ↓
  ├─ 连接 WebSocket
  ├─ 写入 .claude/settings.json (PermissionRequest hook)
  ├─ 发送微信确认消息
  └─ 返回 { status: 'entered', headless: true }
  ↓
Claude 开始长轮询 get_pending_messages(timeout_ms=30000)
  ↓
┌─────────────────────────────────────────┐
│  loop:                                  │
│    1. 等待用户消息（30秒超时）            │
│    2. 收到消息 → 理解意图 → 执行操作      │
│    3. Hook 自动拦截审批 → 发送微信卡片    │
│    4. 用户审批 → 操作完成 → 汇报结果      │
│    5. 继续轮询                           │
└─────────────────────────────────────────┘
  ↓
用户：我回来了
  ↓
Claude → exit_headless_mode()
  ├─ 断开 WebSocket
  ├─ 删除 .claude/settings.json hook
  └─ 发送微信确认消息
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
- 写入 MCP 配置到 `~/.claude.json`
- 注册 PermissionRequest hook 到 `~/.claude/settings.local.json`
- 安装 headless-mode skill 到 `~/.claude/skills/`
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
| `npx @vrs-soft/wecom-aibot-mcp --uninstall` | 完全卸载 |

### 添加新机器人

适用于团队多人场景：

```bash
npx @vrs-soft/wecom-aibot-mcp --add
# 输入机器人名称（如"张三的机器人"）
# 输入 Bot ID 和 Secret
# 发送消息识别用户
```

## 快速开始

### 配置 Claude Code

配置向导会自动写入 `~/.claude.json`：

```json
{
  "mcpServers": {
    "wecom-aibot": {
      "type": "http",
      "url": "http://127.0.0.1:18963/mcp"
    }
  }
}
```

### 启动服务

```bash
npx @vrs-soft/wecom-aibot-mcp --start
```

输出：
```
[mcp] MCP Server 已在后台启动
[mcp] HTTP endpoint: http://127.0.0.1:18963/mcp
[mcp] 健康检查: curl http://127.0.0.1:18963/health
[mcp] 停止服务: npx @vrs-soft/wecom-aibot-mcp --stop
```

### 重启 Claude Code

运行 `/mcp` 命令，选择「Reconnect」重新连接 MCP 服务。

## 使用示例

### Headless 模式（远程审批）

```
你：现在开始通过微信联系

Claude：已进入微信模式，所有交互将通过企业微信进行。
微信收到：【cc-1】已进入微信模式，使用机器人「工作机器人」。

[你离开电脑，Claude 需要执行删除文件操作]

微信收到审批卡片：
┌─────────────────────────┐
│ 【待审批】Bash           │
│ 执行命令: rm -rf dist    │
│ [允许一次] [拒绝]        │
└─────────────────────────┘

[你在手机点击"允许一次"]

Claude 继续执行，发送结果到微信。

你：我回来了

Claude：已退出微信模式，恢复终端交互。
```

### 发送任务通知

```
你：帮我重构这个函数，完成后微信通知我

Claude：[执行重构...]
微信收到：【完成】函数重构完成！
```

### 群聊机器人

将机器人拉入群聊：

```
群聊中：
张三：@Claude助手 查看服务器日志

Claude：执行命令，发送结果到群聊
```

## MCP 工具

| 工具 | 说明 | 参数 |
|------|------|------|
| `send_message` | 发送消息到微信 | `content`, `target_user` |
| `get_pending_messages` | 获取待处理消息（长轮询） | `clear`, `timeout_ms` |
| `enter_headless_mode` | 进入微信模式 | `agent_name`, `robot_id` |
| `exit_headless_mode` | 退出微信模式 | `agent_name` |
| `check_connection` | 检查连接状态 | - |
| `list_robots` | 列出所有机器人 | - |
| `get_connection_stats` | 获取连接统计 | `recent_logs` |
| `detect_user_from_message` | 从消息识别用户 | `timeout` |
| `get_setup_guide` | 获取安装指南 | - |

## 配置说明

### 多机器人配置

支持多个机器人独立使用：

```json
// ~/.wecom-aibot-mcp/config.json
{
  "botId": "bot-xxx",
  "secret": "sec-yyy",
  "targetUserId": "user1",
  "nameTag": "机器人1"
}

// ~/.wecom-aibot-mcp/robot-1234567890.json
{
  "botId": "bot-zzz",
  "secret": "sec-www",
  "targetUserId": "user2",
  "nameTag": "机器人2"
}
```

使用 `list_robots` 查看所有机器人状态：

```json
{
  "robots": [
    {"name": "机器人1", "status": "connected"},
    {"name": "机器人2", "status": "available"}
  ],
  "total": 2,
  "connected": 1,
  "occupied": 0
}
```

## 故障排查

### 认证失败（错误码 40058）

1. 新建机器人需等待约 2 分钟同步
2. 完成授权：机器人详情 → 可使用权限 → 授权
3. 检查 Bot ID 和 Secret 是否正确

### 连接问题

```bash
# 检查服务状态
curl http://127.0.0.1:18963/health

# 查看日志
tail -f ~/.wecom-aibot-mcp/connection.log

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
# 克隆仓库
git clone https://github.com/eric2877/wecom-aibot-mcp.git
cd wecom-aibot-mcp

# 安装依赖
npm install

# 开发模式
npm run dev

# 构建
npm run build

# 测试
npm test
```

## License

MIT

## 相关链接

- [企业微信智能机器人文档](https://developer.work.weixin.qq.com/document/path/101039)
- [Claude Code 文档](https://docs.anthropic.com/claude-code)
- [MCP 协议规范](https://modelcontextprotocol.io)
