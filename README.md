# @vrs-soft/wecom-aibot-mcp

企业微信智能机器人 MCP 服务 - Claude Code 远程审批通道

> 通过企业微信智能机器人实现 Claude Code 的远程审批和消息推送，离开电脑也能处理决策请求。

## 功能特性

- 🔐 **远程审批**：敏感操作通过微信卡片审批，支持"允许一次/永久允许/拒绝"
- 💬 **消息推送**：任务进度、完成通知实时推送到微信
- 📱 **Headless 模式**：离开电脑时切换到微信交互
- 🔄 **多实例支持**：多个 Claude Code 可同时运行，自动分配端口
- 🧹 **自动清理**：进程退出后自动清理残留文件

## 安装

```bash
# 直接运行（推荐）
npx @vrs-soft/wecom-aibot-mcp

# 或全局安装
npm install -g @vrs-soft/wecom-aibot-mcp
wecom-aibot-mcp
```

## 快速开始

### 1. 创建企业微信机器人

1. 登录企业微信管理后台：work.weixin.qq.com
2. 进入「管理工具」→「智能机器人」
3. 点击「创建机器人」→「手动创建」
4. 在「API 配置」中选择「使用长连接」
5. 获取 **Bot ID** 和 **Secret**

### 2. 配置 Claude Code

编辑 `~/.claude.json`，添加 MCP 服务：

```json
{
  "mcpServers": {
    "wecom-aibot": {
      "command": "npx",
      "args": ["@vrs-soft/wecom-aibot-mcp"],
      "env": {
        "WECOM_BOT_ID": "your_bot_id",
        "WECOM_SECRET": "your_secret",
        "WECOM_TARGET_USER": "your_userid"
      }
    }
  }
}
```

### 3. 重启 Claude Code

运行 `/mcp` 重新加载配置，首次运行会自动：
- 启动配置向导（如果环境变量不完整）
- 注册权限预授权
- 安装审批 Hook

## 使用方式

### 普通模式（在电脑前）

审批请求会弹出终端确认框，正常处理。

### Headless 模式（离开电脑）

告诉 Claude：「现在开始通过微信联系」，系统会：
1. 切换到微信审批模式
2. 所有审批请求发送到手机
3. 在微信点击按钮响应

结束时说：「我回来了」或「结束微信模式」。

## MCP 工具

| 工具 | 说明 |
|------|------|
| `send_message` | 发送消息到微信 |
| `send_approval_request` | 发送审批请求（带按钮卡片） |
| `get_approval_result` | 获取审批结果 |
| `check_connection` | 检查连接状态 |
| `get_pending_messages` | 获取用户消息（轮询） |
| `enter_headless_mode` | 进入微信审批模式 |
| `exit_headless_mode` | 退出微信审批模式 |

## 多用户配置

每个用户使用独立的机器人：

```json
{
  "mcpServers": {
    "wecom-aibot-zhangsan": {
      "command": "npx",
      "args": ["@vrs-soft/wecom-aibot-mcp"],
      "env": {
        "WECOM_BOT_ID": "bot_zhangsan",
        "WECOM_SECRET": "secret_zhangsan",
        "WECOM_TARGET_USER": "zhangsan"
      }
    },
    "wecom-aibot-lisi": {
      "command": "npx",
      "args": ["@vrs-soft/wecom-aibot-mcp"],
      "env": {
        "WECOM_BOT_ID": "bot_lisi",
        "WECOM_SECRET": "secret_lisi",
        "WECOM_TARGET_USER": "lisi"
      }
    }
  }
}
```

## 环境变量

| 变量 | 说明 | 必填 |
|------|------|------|
| `WECOM_BOT_ID` | 机器人 ID | ✅ |
| `WECOM_SECRET` | 机器人密钥 | ✅ |
| `WECOM_TARGET_USER` | 默认目标用户 ID | ✅ |

## 故障排查

### 无法收到消息
- 确认机器人已添加到通讯录
- 群聊需要 @机器人 才能触发

### 连接失败
- 检查 Bot ID 和 Secret 是否正确
- 确认网络可以访问 `wss://openws.work.weixin.qq.com`
- 确认没有其他客户端同时连接同一个机器人

### 审批没发到微信
- 检查是否进入了 headless 模式
- 运行 `ls ~/.wecom-aibot-mcp/headless-*` 检查状态文件

## License

MIT