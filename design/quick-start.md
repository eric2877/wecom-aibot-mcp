# 快速开始指南

## 安装

```bash
# 直接运行（无需安装）
npx @various/wecom-aibot-mcp
```

## 配置方式

### 方式 1：环境变量（推荐）

编辑 `~/.claude.json`：

```json
{
  "mcpServers": {
    "wecom-aibot": {
      "command": "npx",
      "args": ["@various/wecom-aibot-mcp"],
      "env": {
        "WECOM_BOT_ID": "your_bot_id",
        "WECOM_SECRET": "your_secret",
        "WECOM_TARGET_USER": "your_userid"
      }
    }
  }
}
```

### 方式 2：首次运行配置向导

首次运行时自动启动配置向导，引导输入 Bot ID、Secret、Target User。

## 获取凭证

1. 登录企业微信管理后台：https://work.weixin.qq.com
2. 进入「管理工具」→「智能机器人」
3. 点击「创建机器人」→「手动创建」
4. 在「API 配置」中选择「使用长连接」
5. 获取 **Bot ID** 和 **Secret**

**Target User ID**：你的企业微信用户 ID（如 `zhangsan`）

## 权限配置

首次运行时，配置向导会自动写入权限到 `~/.claude/settings.local.json`：

```json
{
  "permissions": {
    "allow": [
      "mcp__wecom-aibot__send_message",
      "mcp__wecom-aibot__send_approval_request",
      "mcp__wecom-aibot__get_approval_result",
      "mcp__wecom-aibot__check_connection",
      "mcp__wecom-aibot__get_pending_messages",
      "mcp__wecom-aibot__get_setup_guide",
      "mcp__wecom-aibot__add_robot_config"
    ]
  }
}
```

**为什么必须预授权？**
- 不预授权会弹出确认对话框
- headless 模式下无法点击确认
- 工作流会被阻断

## 使用流程

### 1. 启动 Claude Code

```bash
claude-code
```

### 2. 进入 Headless 模式

说「现在开始通过微信联系」或「我要离开电脑前」

### 3. AI 自动请求审批

当 AI 需要执行敏感操作时：
1. 微信收到审批卡片
2. 点击「允许」或「拒绝」
3. AI 继续执行或取消

### 4. 发送指令

在企业微信中向机器人发送消息，AI 会收到并处理。

### 5. 结束 Headless 模式

说「回到电脑前」或「结束微信模式」

## 多用户配置

每个用户使用独立机器人：

```json
{
  "mcpServers": {
    "wecom-aibot-zhangsan": {
      "command": "npx",
      "args": ["@various/wecom-aibot-mcp"],
      "env": {
        "WECOM_BOT_ID": "bot_zhangsan",
        "WECOM_SECRET": "secret_zhangsan",
        "WECOM_TARGET_USER": "zhangsan"
      }
    },
    "wecom-aibot-lisi": {
      "command": "npx",
      "args": ["@various/wecom-aibot-mcp"],
      "env": {
        "WECOM_BOT_ID": "bot_lisi",
        "WECOM_SECRET": "secret_lisi",
        "WECOM_TARGET_USER": "lisi"
      }
    }
  }
}
```

## 验证安装

```bash
# 检查 MCP 是否加载
claude-code
> /mcp

# 应显示 wecom-aibot 服务
```

## 常见问题

### Q: WebSocket 连接失败？

检查：
- Bot ID 和 Secret 是否正确
- 企业微信后台是否启用了长连接
- 网络是否可访问 `wss://openws.work.weixin.qq.com`

### Q: 审批请求未收到？

检查：
- Target User ID 是否正确
- 用户是否在机器人通讯录中
- WebSocket 连接状态（调用 `check_connection`）

### Q: 消息发送失败？

可能是连接断开，等待自动重连（5-10秒）

## 技术支持

- GitHub Issues: https://github.com/various/wecom-aibot-mcp/issues
- 企业微信开发文档: https://developer.work.weixin.qq.com/document/path/94570