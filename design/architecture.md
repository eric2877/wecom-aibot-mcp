# 架构设计

## 整体架构

```
┌──────────────────┐      MCP (stdio)       ┌──────────────────┐
│   Claude Code    │  ─────────────────→    │   wecom-aibot    │
│   (MCP Client)   │                        │   MCP Server     │
└──────────────────┘                        └──────────────────┘
                                                    │
                                            WebSocket 长连接
                                                    ↓
                                            ┌───────────────────┐
                                            │   企业微信服务器    │
                                            │ wss://openws...    │
                                            └───────────────────┘
                                                    │
                                                    ↓
                                            ┌───────────────────┐
                                            │  用户企业微信客户端  │
                                            └───────────────────┘
```

## 进程模型

```
npx @various/wecom-aibot-mcp
    │
    ├── MCP Server (stdio)
    │   └── 接收 Claude Code 工具调用
    │
    ├── WebSocket Client
    │   └── 与企业微信服务器保持长连接
    │
    └── 消息队列
        ├── 审批请求/响应 Map
        └── 用户消息队列
```

## 消息流

### 审批请求流程

```
Claude Code                    MCP Server                    微信服务器
    │                              │                              │
    │  send_approval_request       │                              │
    │ ───────────────────────────> │                              │
    │                              │  发送模板卡片                  │
    │                              │ ────────────────────────────> │
    │                              │                              │
    │                              │                              │  用户点击
    │                              │                              │  ↓
    │                              │  template_card_event         │
    │                              │ <──────────────────────────── │
    │                              │                              │
    │  get_approval_result         │                              │
    │ ───────────────────────────> │                              │
    │                              │  轮询 approval Map            │
    │                              │  ↓                           │
    │  返回 "allow-once"           │                              │
    │ <─────────────────────────── │                              │
```

### 消息接收流程

```
微信客户端                      微信服务器                    MCP Server
    │                              │                              │
    │  用户发送消息                 │                              │
    │ ────────────────────────────> │                              │
    │                              │  WebSocket message            │
    │                              │ ────────────────────────────> │
    │                              │                              │
    │                              │                              │  存入 messages[]
    │                              │                              │
    │                              │                              │
    │  Claude Code 调用 get_pending_messages                      │
    │                              │                              │  返回队列内容
```

## 多实例架构

每个 MCP 实例对应一个企业微信机器人（一个 Bot ID）：

```
Claude Code Session A
    └── MCP 实例 wecom-aibot-userA
            └── WebSocket → Bot A

Claude Code Session B
    └── MCP 实例 wecom-aibot-userB
            └── WebSocket → Bot B
```

**限制**：一个机器人同时只能保持一个 WebSocket 长连接。

## 关键设计决策

### 1. 无限等待审批结果

```typescript
getApprovalResult(taskId: string, timeoutMs = 0): Promise<string> {
  // timeoutMs = 0 表示无限等待
  // 适合用户离开电脑前的 overnight 场景
}
```

### 2. 消息队列而非回调

使用消息队列而非回调机制：
- 解耦发送和接收
- 支持批量获取
- 避免丢失消息

### 3. AI 主动控制审批

不使用 hooks，由 AI 在执行敏感操作前主动调用 MCP 审批：
- 更灵活的审批判断
- 避免 hooks 配置复杂性
- 用户可通过微信实时控制