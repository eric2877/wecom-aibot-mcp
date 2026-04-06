# Hook 审批机制问题解决

> **日期**：2026-04-06
> **问题**：断线审批超时自动拒绝、审批消息路由问题

---

## 一、问题描述

### 1.1 现象

1. **断线时审批丢失**：用户在断线期间发起审批，重连后审批未恢复
2. **超时自动拒绝**：审批超时（10 分钟）后自动拒绝，影响用户体验
3. **无法追踪问题**：Hook 脚本无 debug 日志，无法定位问题

### 1.2 根因分析

| 问题 | 根因 | 影响 |
|------|------|------|
| 断线审批丢失 | 断线时未创建审批记录，taskId 不匹配 | Hook 轮询永远 pending |
| 超时自动拒绝 | `onApprovalTimeout` 直接设置 `deny` | 用户需重新执行操作 |
| 无法追踪 | Hook 脚本无 stderr debug 输出 | 问题定位困难 |

---

## 二、解决方案

### 2.1 断线审批：始终创建审批记录

**修改文件**：`src/client.ts`

**修改前**（断线时才创建记录）：
```typescript
// 断线时将审批请求加入队列，并返回 taskId
if (!this.connected) {
  this.pendingMessages.push({ ... });
  return taskId;  // ❌ 审批记录未创建
}

// 存储审批记录（只有连接时才执行）
this.approvals.set(taskId, { ... });
```

**修改后**（始终创建记录）：
```typescript
// 始终存储审批记录（断线时也需要，让 Hook 能轮询到）
this.approvals.set(taskId, {
  taskId,
  resolved: false,
  timestamp: Date.now(),
  toolName,
});

// 断线时将审批请求加入队列
if (!this.connected) {
  this.pendingMessages.push({
    type: 'approval',
    content: { ..., taskId },  // ✅ 保存原始 taskId
    ...
  });
  return taskId;
}
```

**效果**：
- 断线时审批记录已创建，Hook 轮询能找到
- 重连后使用原始 taskId 发送审批卡片，结果能正确匹配

### 2.2 超时处理：发送提醒而非拒绝

**修改文件**：`src/http-server.ts`

**修改前**：
```typescript
async function onApprovalTimeout(taskId: string): Promise<void> {
  // ...
  if (result === 'pending') {
    entry.status = 'deny';  // ❌ 直接拒绝
    await client.sendText(`【审批超时】已自动拒绝...`);
  }
  pendingApprovals.delete(taskId);
}
```

**修改后**：
```typescript
async function onApprovalTimeout(taskId: string): Promise<void> {
  // ...
  if (result === 'pending') {
    // 发送提醒，不改变状态
    await client.sendText(`【审批提醒】您有 ${waitTime} 分钟前的审批请求待处理...`);

    // 重新设置超时计时器（再等 10 分钟）
    entry.timer = setTimeout(() => onApprovalTimeout(taskId), APPROVAL_TIMEOUT_MS);
  }
}
```

**效果**：
- 审批始终 pending，CC 持续阻塞等待
- 每隔 10 分钟发送提醒，不会自动拒绝

### 2.3 Hook Debug 日志

**修改文件**：`~/.wecom-aibot-mcp/permission-hook.sh`

**添加内容**：
```bash
# 每一步都输出 debug 到 stderr
echo "[DEBUG] Step1: Hook received input: $INPUT" >&2
echo "[DEBUG] Step2: Tool name: $TOOL_NAME" >&2
echo "[DEBUG] Step5: Headless file exists: yes/no" >&2
echo "[DEBUG] Step6: Health response: $HEALTH" >&2
echo "[DEBUG] Step7: Approval response: $RESPONSE" >&2
echo "[DEBUG] Step9: Poll #$N: result=$RESULT" >&2
```

**效果**：可追踪完整审批链路，快速定位问题

### 2.4 调试接口修复

**问题**：`disconnectRobot` 会删除 connectionPool 中的状态，导致待发送消息丢失。

**修复**：调试端点只断开连接，不删除状态：

```typescript
// 修改前：删除状态
disconnectRobot(robotName);  // ❌ 删除状态，丢失待发送消息

// 修改后：只断开连接
const client = await getClient(robotName);
if (client) {
  client.disconnect();  // ✅ 只断开连接，状态保留
}
```

**效果**：待发送消息队列保留，重连后能正确刷新。

---

## 三、调试接口

新增以下调试端点（MCP Server 18963 端口）：

| 端点 | 方法 | 说明 |
|------|------|------|
| `/debug/connections` | GET | 获取所有连接状态 |
| `/debug/disconnect/:name` | POST | 断开指定机器人 |
| `/debug/reconnect/:name` | POST | 重连指定机器人 |

**使用示例**：
```bash
# 查看连接状态
curl http://127.0.0.1:18963/debug/connections

# 断开 ClaudeCode
curl -X POST http://127.0.0.1:18963/debug/disconnect/ClaudeCode

# 重连 ClaudeCode
curl -X POST http://127.0.0.1:18963/debug/reconnect/ClaudeCode
```

---

## 四、完整审批链路

```
Step 1: 用户执行敏感操作（Bash、Write、Edit）
    ↓
Step 2: Harness 触发 PermissionRequest 事件
    ↓
Step 3: Hook 脚本被调用（stdin = 请求 JSON）
    ↓
Step 4: Hook 检查 headless 状态文件
    ↓
Step 5: Hook 检查 MCP Server 健康
    ↓
Step 6: Hook 发送 POST /approve 到 MCP Server
    ↓
Step 7: MCP Server 获取 WebSocket 客户端
    ↓
Step 8: Client.sendApprovalRequest()
    - 创建审批记录（始终创建）
    - 断线时加入 pendingMessages 队列
    - 在线时发送 template_card
    ↓
Step 9: Hook 轮询 GET /approval_status/:taskId
    ↓ (阻塞等待)
Step 10: 用户点击审批按钮
    ↓
Step 11: WebSocket 收到 template_card_event
    ↓
Step 12: Client.handleApprovalResponse() 更新审批记录
    ↓
Step 13: Hook 获取结果，返回 allow/deny
    ↓
Step 14: 工具执行或拒绝
```

---

## 五、心得总结

### 5.1 设计原则

1. **状态一致性**：审批记录应在请求发起时就创建，不应依赖连接状态
2. **用户体验**：超时应提醒而非自动决策，避免误操作
3. **可观测性**：关键链路必须有 debug 日志，便于问题定位

### 5.2 架构要点

1. **Hook 阻塞轮询**：Hook 在等待审批时阻塞，这是 Claude Code Harness 的设计
2. **MCP Server 驱动**：超时提醒由 MCP Server 发送，CC 此时被阻塞
3. **断线重连恢复**：pendingMessages 队列保留原始 taskId，重连后使用相同 taskId 发送

### 5.3 避免的坑

1. **不要在断线时跳过状态创建**：会导致 taskId 无法匹配
2. **不要自动拒绝超时审批**：用户可能只是离开一会儿
3. **不要假设连接状态**：审批请求可能在任何连接状态下发起