# 企业微信智能机器人 MCP 服务 - 设计文档

## 项目概述

本项目实现了一个 MCP (Model Context Protocol) 服务，使 Claude Code 能够通过企业微信智能机器人与用户进行远程交互，主要用途：

1. **远程审批通道** - 在 headless 模式下，用户离开电脑前，AI 可通过微信请求操作审批
2. **消息通知** - 任务进度、完成状态推送到微信
3. **用户指令接收** - 用户通过微信发送指令控制 AI 行为

## 核心场景

```
用户离开电脑前
    ↓
说「现在开始通过微信联系」
    ↓
进入 Headless 模式
    ↓
AI 执行敏感操作前发送审批请求到微信
    ↓
用户在微信点击按钮
    ↓
AI 根据结果继续执行
```

## 技术栈

- **MCP SDK**: `@modelcontextprotocol/sdk` - 标准 MCP 协议实现
- **企业微信 SDK**: `@wecom/aibot-node-sdk` - WebSocket 长连接
- **运行时**: Node.js + TypeScript
- **传输层**: stdio (MCP) + WebSocket (微信)

## 目录结构

```
wecom-aibot-mcp/
├── src/
│   ├── index.ts          # MCP Server 入口（库导出）
│   ├── bin.ts            # npx 运行入口
│   ├── client.ts         # WebSocket 客户端管理
│   ├── config-wizard.ts  # 配置向导
│   ├── http-server.ts    # 本地 HTTP 服务（备用）
│   └── tools/
│       └── index.ts      # MCP 工具注册
├── hooks/                # Hook 脚本（备用）
├── design/               # 设计文档
├── dist/                 # 编译输出
└── package.json
```

## 配置方式

### 环境变量（推荐）

```bash
WECOM_BOT_ID=your_bot_id
WECOM_SECRET=your_secret
WECOM_TARGET_USER=userid
```

在 `~/.claude.json` 中配置：

```json
{
  "mcpServers": {
    "wecom-aibot": {
      "command": "npx",
      "args": ["@various/wecom-aibot-mcp"],
      "env": {
        "WECOM_BOT_ID": "your_bot_id",
        "WECOM_SECRET": "your_secret",
        "WECOM_TARGET_USER": "userid"
      }
    }
  }
}
```

### 首次运行配置向导

首次运行时，自动启动配置向导引导输入凭证。

## 发布方式

```bash
npm publish --access public
```

包名：`@various/wecom-aibot-mcp`

## 版本历史

- v1.0.0 - 初始版本，支持审批流程、消息收发