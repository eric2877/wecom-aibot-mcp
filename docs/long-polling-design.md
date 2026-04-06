# 长轮询消息接收设计

> **日期**：2026-04-06  
> **背景**：探索 Claude Code 与 MCP 双向推送方案后的最终实现

---

## 一、探索历程

### 1.1 尝试过的方案

| 方案 | 结果 | 原因 |
|------|------|------|
| SSE `notifications/message` | ❌ | Claude Code 收到通知但不响应，仅写入日志面板 |
| `sampling/createMessage` | ❌ | 测试返回 `-32601: Method not found`，Claude Code 未实现该 handler |
| Hook 触发 | ❌ | Hook 只响应 Claude 的行为，无法被外部事件触发 |
| **长轮询（Long Polling）** | ✅ | 唯一可行路径 |

### 1.2 根本限制

Claude Code 是**单线程对话模型**，Claude 只能主动拉取，不能被动推送：

```
外部事件（微信消息）无法注入 Claude 的对话上下文
↓
唯一路径：Claude 主动调用工具等待消息
```

---

## 二、方案设计

### 2.1 核心思路

借鉴 `mcp__openclaw__events_wait` 的设计——**阻塞等待，有事件立即返回**：

```
旧方案（短轮询）：
  Claude → get_pending_messages() → 立即返回空 → 等 5 秒 → 重复
  每分钟唤醒 12 次，响应延迟最多 5 秒

新方案（长轮询）：
  Claude → get_pending_messages(timeout_ms: 30000) → 阻塞等待
  消息到达 → 立即返回（毫秒级）
  无消息 → 等满 30 秒后返回空
  每分钟最多唤醒 2 次
```

### 2.2 实现原理

```
MCP Server 内部：
  1. 检查 client.getPendingMessages() → 有则立即返回
  2. 无积压消息且 timeout_ms > 0 → 进入等待
  3. subscribeWecomMessageByRobot(robotName, callback)
     └── Promise.race([消息到达, setTimeout(timeout_ms)])
  4. 消息到达 → unsubscribe → resolve → 返回消息
  5. 超时 → unsubscribe → resolve(null) → 返回空 + timeout: true
```

### 2.3 Session 路由

```
extra.sessionId
  → getSessionDataById()
  → { robotName: "ClaudeCode", ccId: "cc-1" }
  → subscribeWecomMessageByRobot("ClaudeCode", ...)
```

每个 Claude Code 实例通过 `sessionId → robotName` 只订阅自己机器人的消息，多 CC 实例互不干扰。

---

## 三、实现

### 3.1 工具签名变更

**文件**：`src/tools/index.ts`

```typescript
server.tool(
  'get_pending_messages',
  '获取待处理的微信消息。支持长轮询：传入 timeout_ms 后阻塞等待，有消息立即返回，无消息等到超时。',
  {
    clear: z.boolean().optional().default(true),
    timeout_ms: z.number().optional().default(0)  // 新增，最大 60000ms
  },
  async ({ clear, timeout_ms = 0 }, extra) => { ... }
)
```

### 3.2 核心等待逻辑

```typescript
const arrived = await new Promise<WecomMessage | null>(resolve => {
  const timer = setTimeout(() => {
    sub.unsubscribe();
    resolve(null);
  }, waitMs);

  const sub = subscribeWecomMessageByRobot(robotName, (msg) => {
    clearTimeout(timer);
    sub.unsubscribe();
    resolve(msg);
  });
});
```

### 3.3 返回格式

```json
// 有消息时（立即返回）
{ "count": 1, "messages": [{ "content": "...", "from": "...", ... }] }

// 超时时
{ "count": 0, "messages": [], "timeout": true }
```

---

## 四、验证结果

### 4.1 超时测试（空等 10 秒）

```
调用: get_pending_messages(timeout_ms: 10000)
耗时: 10041ms
结果: { count: 0, messages: [], timeout: true }
✅ 精确等待 10 秒后返回
```

### 4.2 即时返回测试（等待中接收消息）

```
长轮询开始: 22:31:56.555（timeout_ms: 30000）
用户发送"好的": 22:32:13.539
长轮询返回: 22:32:13.592

响应延迟: ~53ms（毫秒级）
等待时间: 17 秒（未等满 30 秒）
✅ 消息到达立即唤醒
```

---

## 五、使用方式

### 5.1 Claude headless 模式轮询

```
# 之前（5 秒短轮询）
loop:
  get_pending_messages()
  sleep 5s

# 现在（30 秒长轮询）
loop:
  get_pending_messages(timeout_ms: 30000)
  # 有消息立即处理，无消息 30 秒后重新调用
```

### 5.2 参数建议

| 场景 | timeout_ms | 说明 |
|------|-----------|------|
| 正常 headless | 30000 | 响应快，token 少 |
| 省电模式 | 60000 | 用户长时间未响应时 |
| 立即查询 | 0（默认） | 不等待，向后兼容 |

---

## 六、对比总结

| 指标 | 短轮询（旧） | 长轮询（新） |
|------|------------|------------|
| 响应延迟 | 最多 5 秒 | 毫秒级 |
| 每分钟唤醒次数 | 12 次 | ≤ 2 次 |
| Token 消耗 | 高 | 低（约 1/6） |
| 实现复杂度 | 简单 | 中等 |
| 阻断 CC | 是（轮询期间） | 是（等待期间） |

> **注**：两种方案都会阻断 Claude Code，但 headless 模式下用户本就不在电脑前，阻断无副作用。
