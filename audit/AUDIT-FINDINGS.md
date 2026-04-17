# wecom-aibot-mcp 审计发现汇总

> **版本**：v2.4.7（架构 v3.1）
> **审计日期**：2026-04-17
> **文件范围**：src/ · permission-hook.sh · design/
> **格式说明**：每个问题包含「是什么 → 在哪里 → 为什么 → 怎么改」四段，供 agent 直接定位和修复

---

## 如何阅读本文档

- **BUG-xxx**：可独立修复的 Bug，有明确的错误代码和修复方向
- **DESIGN-xxx**：设计层面的缺陷，修复需要改动多个文件
- **优先级**：🔴 高（影响正确性或安全性）/ 🟡 中（影响稳定性）/ 🟢 低（质量改进）
- 每条问题末尾列出**受影响文件**和**最小修复指引**

---

## 一、审批链路（Approval Flow）

### BUG-001 🔴 exit_headless_mode 退出后 SSE 仍重连

**是什么**  
调用 `exit_headless_mode` 后，channel-server 的 SSE 连接会在 3 秒后自动重连，产生无效的 `/sse/{ccId}` 请求循环，直到进程退出。

**在哪里**  
`src/channel-server.ts`，`exit_headless_mode` 工具实现（约 L544）：

```typescript
sseAbortController.abort();   // 先 abort，signal.aborted = true
sseAbortController = null;    // 再置 null ← 问题根源

// 之后 .catch 处理器执行：
if (!sseAbortController?.signal.aborted) {
  //  ^^ null?.signal = undefined，!undefined = true ← 永远 true
  setTimeout(() => connectSSE(ccId), 3000);   // 退出后仍重连
}
```

**为什么**  
`sseAbortController = null` 在 `.catch` 回调之前执行（同步），导致 `.catch` 检查 `null?.signal.aborted` 得到 `undefined`，重连保护失效。

**怎么改**  
在 `channel-server.ts` 顶层增加一个退出标记变量：

```typescript
let sseExiting = false;

// exit_headless_mode 工具中：
sseExiting = true;
sseAbortController?.abort();
sseAbortController = null;
sseConnected = false;

// connectSSE 的 .catch 和 done 处理中：
if (!sseExiting) {
  setTimeout(() => connectSSE(ccId), 3000);
}

// connectSSE 调用时重置：
sseExiting = false;
sseConnected = true;
```

**受影响文件**：`src/channel-server.ts`

---

### BUG-002 🔴 POST /approve 的 curl 10 秒超时 → 操作被静默放行

**是什么**  
Hook 脚本获取 taskId 的 curl 请求有 10 秒超时限制（`-m 10`）。超时后 taskId 为空，Hook 执行 `exit 0`，Claude Code 将此解释为**允许**，操作绕过审批直接执行。

**注意区分两个超时**：
- 此处的 10 秒（`-m 10`）：等待 `POST /approve` 返回 taskId 的网络超时
- `autoApproveTimeout`（默认 600 秒）：用户未响应后的智能代批超时，有判断标准，设计是正确的

**在哪里**  
`~/.wecom-aibot-mcp/permission-hook.sh`，约 L104-114：

```bash
RESPONSE=$(curl -s -m 10 -X POST "$MCP_BASE_URL/approve" ...)
TASK_ID=$(echo "$RESPONSE" | jq -r '.taskId // empty')
if [[ -z "$TASK_ID" ]]; then
  exit 0   # ← 放行，完全绕过审批
fi
```

**为什么**  
`POST /approve` 内部调用 `client.sendApprovalRequest()` 发送微信卡片，这依赖企业微信 API 的网络响应。API 限流、网络抖动或 MCP Server 高负载时，10 秒内无法完成，curl 超时返回空响应。

**怎么改**  
获取 taskId 失败时应**拒绝**（而非放行），保守失败：

```bash
TASK_ID=$(echo "$RESPONSE" | jq -r '.taskId // empty')
if [[ -z "$TASK_ID" ]]; then
  log_debug "[$(date)] /approve 无响应，保守拒绝"
  printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"审批服务无响应，已拒绝（安全默认行为）请重试"}}}'
  exit 0
fi
```

**受影响文件**：`~/.wecom-aibot-mcp/permission-hook.sh`

---

### BUG-003 🔴 重连后 injectApprovalRecord 丢失 ccId → SSE 审批通知失效

**是什么**  
WebSocket 重连时，`connection-manager.ts` 将旧 client 的未解决审批记录迁移到新 client，但迁移时**没有传入 ccId**。导致重连后用户点击审批，结果通过 SSE 通知 channel-server 时 `ccId` 为空，通知无法发出。

**在哪里**  
`src/connection-manager.ts` L199-213：

```typescript
const pendingApprovals = oldClient.getUnresolvedApprovalMap();
// getUnresolvedApprovalMap() 返回完整 ApprovalRecord，含 ccId

pendingApprovals.forEach((approval, taskId) => {
  state.client.injectApprovalRecord(taskId, {
    toolName: approval.toolName,
    toolInput: approval.toolInput,
    // ← ccId 没有传入，丢失
  });
});
```

`src/client.ts` L690-703，`injectApprovalRecord` 参数类型只接受 `{ toolName?, toolInput? }`，没有 `ccId`：

```typescript
injectApprovalRecord(
  taskId: string,
  partial: { toolName?: string; toolInput?: Record<string, unknown> }
): void {
  this.approvals.set(taskId, {
    taskId, resolved: false, timestamp: Date.now(),
    toolName: partial.toolName,
    toolInput: partial.toolInput,
    // ccId 永远是 undefined
  });
}
```

**为什么**  
重连后，用户点击审批 → `handleApprovalResponse` → `publishApprovalEvent({ ccId: approval.ccId })` → `approval.ccId = undefined` → `handleApprovalEvent` 检查 `if (event.ccId)` 为 false → **SSE 审批推送完全跳过**。

**怎么改**

第一步：扩展 `injectApprovalRecord` 参数类型（`src/client.ts`）：

```typescript
injectApprovalRecord(
  taskId: string,
  partial: { toolName?: string; toolInput?: Record<string, unknown>; ccId?: string }
): void {
  this.approvals.set(taskId, {
    taskId, resolved: false, timestamp: Date.now(),
    toolName: partial.toolName,
    toolInput: partial.toolInput,
    ccId: partial.ccId,   // ← 新增
  });
}
```

第二步：传入 ccId（`src/connection-manager.ts`）：

```typescript
pendingApprovals.forEach((approval, taskId) => {
  state.client.injectApprovalRecord(taskId, {
    toolName: approval.toolName,
    toolInput: approval.toolInput,
    ccId: approval.ccId,   // ← 新增
  });
});
```

**受影响文件**：`src/client.ts`、`src/connection-manager.ts`

---

### BUG-004 🔴 channel-server 不区分 SSE event 类型 → 审批通知格式错误

**是什么**  
channel-server 接收 SSE 时，`event: message`（微信消息）和 `event: approval`（审批结果）被同等处理，都转发为 `notifications/claude/channel`。审批结果缺少 `cc_id`，内容是原始 JSON，Claude agent 无法识别和利用。

**在哪里**  
`src/channel-server.ts` L313-314：

```typescript
} else if (line.startsWith('event: ')) {
  logChannel('SSE event type', { type: line.slice(7) });
  // ← 只记日志，不区分处理，event 类型被丢弃
}
```

收到审批结果后，`data:` 行被当做普通消息处理：

```typescript
const message = msg.message || {};         // approval 事件没有 .message → {}
const notification = {
  content: message.content || JSON.stringify(msg),  // → '{"type":"approval_result",...}'
  meta: {
    cc_id: msg.ccId || '',  // approval 事件顶层无 ccId → ''
    ...
  }
};
```

Claude 实际收到：
```
<channel cc_id="" from="" ...>
{"type":"approval_result","taskId":"approval_hook_xxx","result":"allow-once"}
</channel>
```

**为什么**  
SSE 协议中 `event:` 行定义了事件类型，必须在解析 `data:` 时保留这个上下文才能正确处理不同类型的事件。

**怎么改**  
在 channel-server SSE 解析循环中跟踪 event 类型，对 `event: approval` 单独处理：

```typescript
let currentEventType = 'message';  // 当前事件类型，跨行保留

for (const line of lines) {
  if (line.startsWith('event: ')) {
    currentEventType = line.slice(7).trim();
  } else if (line.startsWith('data: ')) {
    const msg = JSON.parse(line.slice(6));

    if (currentEventType === 'approval') {
      // 审批结果：独立通知，携带 taskId
      mcpServer.server.notification({
        method: 'notifications/claude/channel',
        params: {
          content: `审批完成：${msg.result === 'allow-once' ? '已允许' : '已拒绝'}`,
          meta: {
            event_type: 'approval',
            task_id: msg.taskId || '',
            result: msg.result || '',
          } as Record<string, string>,
        },
      });
    } else {
      // 微信消息：原有逻辑
      const message = msg.message || {};
      // ... 原有代码 ...
    }
    currentEventType = 'message';  // 重置为默认值
  } else if (line === '') {
    currentEventType = 'message';  // 事件分隔符，重置
  }
  // ...
}
```

**受影响文件**：`src/channel-server.ts`

---

### BUG-005 🟡 SSE buffer 分包 → 长消息静默丢失

**是什么**  
SSE 解析 buffer 管理有缺陷：当 TCP 分包导致 `data: ` 行被切断时，半截内容 JSON 解析失败后被丢弃，下一个 chunk 的剩余内容没有 `data: ` 前缀，永远不会被识别，消息静默丢失。

**在哪里**  
`src/channel-server.ts` L265-322：

```typescript
buffer += chunk;
const lines = buffer.split('\n');
buffer = '';             // ← 先清空 buffer

for (const line of lines) {
  if (line.startsWith('data: ')) {
    try {
      JSON.parse(line.slice(6));  // 半截 JSON → 抛出异常
    } catch (e) {
      // 静默忽略，buffer 已被清空，半截内容丢失
    }
  } else {
    buffer = line;   // 只有不匹配的行才进 buffer
  }
}
```

**为什么**  
正确的 SSE buffer 处理应该保留未处理完的内容（包括不完整的 `data:` 行）。当前实现在识别到 `data:` 前缀后立即尝试解析，解析失败就完全丢弃。

**怎么改**  
不立即清空 buffer，改为在完整事件边界（`\n\n`）处切割：

```typescript
buffer += chunk;
const events = buffer.split('\n\n');
buffer = events.pop() || '';   // 最后一段可能不完整，留在 buffer

for (const event of events) {
  const lines = event.split('\n');
  let eventType = 'message';
  let dataLine = '';

  for (const line of lines) {
    if (line.startsWith('event: ')) {
      eventType = line.slice(7).trim();
    } else if (line.startsWith('data: ')) {
      dataLine = line.slice(6);
    }
  }

  if (dataLine) {
    try {
      const msg = JSON.parse(dataLine);
      // 根据 eventType 处理
    } catch (e) {
      logChannel('JSON parse error', { error: String(e) });
    }
  }
}
```

**受影响文件**：`src/channel-server.ts`

---

### BUG-006 🟡 autoApprove=false + MCP 崩溃 → Hook 永久挂起

**是什么**  
`autoApprove=false` 时，Hook 超时后进入无限轮询循环。当 MCP Server 崩溃，`curl` 每次都超时返回空，`RESULT` 永远为空，循环无法退出，Hook 进程永久挂起，直到 Claude Code 自身超时（默认 600s）才被强制结束。

**在哪里**  
`~/.wecom-aibot-mcp/permission-hook.sh` L157-175：

```bash
while true; do
  sleep 2
  STATUS=$(curl -s -m 3 "$MCP_BASE_URL/approval_status/$TASK_ID" ...)
  RESULT=$(echo "$STATUS" | jq -r '.result // empty')
  # curl 失败时 RESULT="" → 不匹配 allow/deny → 继续循环，永无止境
  if [[ "$RESULT" == "allow-once" || "$RESULT" == "allow-always" ]]; then ...
  elif [[ "$RESULT" == "deny" ]]; then ...
  fi
done
```

**怎么改**  
增加连续失败计数，服务不可达时跳出循环：

```bash
FAIL_COUNT=0
MAX_FAIL=10  # 连续 10 次失败（约 20 秒）视为服务不可达

while true; do
  sleep 2
  STATUS=$(curl -s -m 3 "$MCP_BASE_URL/approval_status/$TASK_ID" ...)
  if [[ -z "$STATUS" ]]; then
    FAIL_COUNT=$((FAIL_COUNT + 1))
    log_debug "[$(date)] curl 失败 $FAIL_COUNT/$MAX_FAIL"
    if [[ $FAIL_COUNT -ge $MAX_FAIL ]]; then
      log_debug "[$(date)] 服务不可达，退出等待"
      exit 0  # 或者 deny，根据保守策略决定
    fi
    continue
  fi
  FAIL_COUNT=0  # 成功后重置
  RESULT=$(echo "$STATUS" | jq -r '.result // empty')
  ...
done
```

**受影响文件**：`~/.wecom-aibot-mcp/permission-hook.sh`

---

### BUG-007 🟡 pendingApprovals Map 永不清理（内存泄漏）

**是什么**  
`http-server.ts` 中的 `pendingApprovals: Map<string, ApprovalEntry>` 在审批完成或过期后从不清理，长期运行的 daemon 会持续增长内存。

**在哪里**  
`src/http-server.ts` L259，无对应的清理逻辑。对比：`WecomClient.cleanupMessages()`（`client.ts` L706）每分钟清理一次，两者不对称。

**怎么改**  
在 `initMcpServer()` 中启动定期清理（与 `WecomClient` 的清理周期一致）：

```typescript
// 每 5 分钟清理超过 30 分钟的 pendingApprovals 条目
setInterval(() => {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [taskId, entry] of pendingApprovals) {
    if (entry.timestamp < cutoff) {
      pendingApprovals.delete(taskId);
      logger.log(`[http] 清理过期审批: ${taskId}`);
    }
  }
}, 5 * 60 * 1000);
```

**受影响文件**：`src/http-server.ts`

---

### BUG-008 🟡 handleApprovalStatus 对未知 taskId 永返 pending → Hook 无法感知丢失

**是什么**  
`GET /approval_status/:taskId` 在 `pendingApprovals` Map 中找不到记录时，返回 `{ status: 'pending', result: 'pending' }`，而非 404。Hook 无法区分「等待中」和「记录丢失」，会一直轮询直到超时。

**在哪里**  
`src/http-server.ts` L1100-1107：

```typescript
// 没找到对应的待处理审批，返回 pending
res.writeHead(200, { 'Content-Type': 'application/json' });
res.end(JSON.stringify({ status: 'pending', result: 'pending' }));
```

**怎么改**  
返回可区分的状态，让 Hook 能识别记录丢失：

```typescript
res.writeHead(200, { 'Content-Type': 'application/json' });
res.end(JSON.stringify({ status: 'not_found', result: 'not_found' }));
```

同时更新 Hook 脚本，识别 `not_found` 状态并执行降级决策（重新发送审批或自动拒绝）。

**受影响文件**：`src/http-server.ts`、`~/.wecom-aibot-mcp/permission-hook.sh`

---

## 二、安全性

### BUG-009 🔴 /push_notification 无白名单 → 可注入任意 MCP 方法

**是什么**  
`POST /push_notification` 接受用户指定的 `method` 字段，直接传给 `server.server.notification({ method, params })`，无白名单限制。未配置 Auth Token 时，任何本地进程可向所有 MCP session 发送任意通知。

**在哪里**  
`src/http-server.ts` L1283-1309：

```typescript
const { method, params } = JSON.parse(body);
// ...
await entry.server.server.notification({ method, params });  // method 完全由请求者控制
```

**怎么改**  
白名单限制 method：

```typescript
const ALLOWED_METHODS = ['notifications/message', 'notifications/claude/channel'];
if (!ALLOWED_METHODS.includes(method)) {
  res.writeHead(400);
  res.end(JSON.stringify({ error: `不支持的 method: ${method}` }));
  return;
}
```

**受影响文件**：`src/http-server.ts`

---

### BUG-010 🟡 调试端点暴露于生产环境

**是什么**  
以下 `/debug/*` 端点没有 `NODE_ENV` 等环境检查，仅靠 Auth Token 保护。未配置 Token 时，任何本地进程均可调用：

| 端点 | 风险 |
|------|------|
| `POST /debug/enter_headless` | 注入任意 ccId 到注册表 |
| `POST /debug/exit_headless` | 清空整个 ccId 注册表 |
| `POST /debug/test_message` | 伪造微信消息推送给任意 ccId |
| `POST /debug/sampling` | 通过 `createMessage` 向 Claude 注入内容 |

**在哪里**  
`src/http-server.ts` L808-940

**怎么改**  
在调试端点的路由处理前加入环境检查：

```typescript
if (process.env.NODE_ENV === 'production') {
  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Not Found' }));
  return;
}
```

**受影响文件**：`src/http-server.ts`

---

## 三、代码质量

### BUG-011 🟡 src/client.ts 残留旧版单例 getClient()

**是什么**  
`src/client.ts` 导出了一个无参数的 `getClient(): WecomClient` 单例函数（旧版本遗留），与 `src/connection-manager.ts` 导出的多机器人版 `getClient(robotName: string)` 同名但语义不同。`src/index.ts` 从 `connection-manager` 导出覆盖了 `client.ts` 的版本，但 `client.ts` 中的旧版本未被删除。

**在哪里**  
`src/client.ts` L801-817

**怎么改**  
删除 `src/client.ts` 中的 `let instance` 和 `getClient()` 单例，只保留 `initClient()` 和类本身导出。

**受影响文件**：`src/client.ts`、`src/index.ts`

---

### BUG-012 🟢 sendNoReferencePrompt 发给错误目标

**是什么**  
多 CC 场景下，当无法路由消息时，`sendNoReferencePrompt` 发送提示给 `client` 的默认 `targetUserId`，而不是发给实际发送消息的 `msg.chatid`（可能是群聊）。

**在哪里**  
`src/http-server.ts` L588-603：

```typescript
const client = await getClient(msg.robotName);
await client.sendText(reply);   // 发给 targetUserId，而非 msg.chatid
```

**怎么改**  

```typescript
await client.sendText(reply, msg.chatid);  // 回复到原始会话
```

**受影响文件**：`src/http-server.ts`

---

### BUG-013 🟢 channel-server.ts 工具编号重复（工具 4 出现两次）

**是什么**  
注释标记 `工具 4` 重复使用，`check_connection`（L392）和 `get_pending_messages`（L400）都被标记为"工具 4"。不影响运行，影响可读性。

**在哪里**  
`src/channel-server.ts` L392、L400

**怎么改**  
将 `get_pending_messages` 的注释改为"工具 5"，后续依次递增。

**受影响文件**：`src/channel-server.ts`

---

## 四、设计层问题（需综合评估再改）

### DESIGN-001 🔴 审批结果通知 Claude 的 SSE 路径设计需重构

**现状**  
HTTP Server → SSE `event: approval` → channel-server → `notifications/claude/channel`

这条路径当前几乎无效：
- BUG-003：ccId 在重连后丢失，SSE 推送被跳过
- BUG-004：event 类型未区分，内容以原始 JSON 转发，Claude 无法使用
- 就算以上修复，Claude agent 收到通知后如何将其与正在执行的操作关联，也缺乏明确的协议

**建议方向**  
审批结果通知应以 `taskId` 为关联键（而非 `ccId`），让 Claude agent 知道「哪个操作刚被审批」：
- `event: approval` 的 `meta` 携带 `task_id` 和 `result`
- Claude agent 在 instructions 中明确：收到 `event_type=approval` 的 channel 通知时，记录审批结果，不需要回复

**受影响文件**：`src/http-server.ts`、`src/channel-server.ts`、`skills/headless-mode/SKILL.md`

---

### DESIGN-002 🟡 ccId 注册表纯内存，重启后丢失

**现状**  
`ccIdRegistry: Map<string, CCRegistryEntry>` 在 `src/http-server.ts` 中是纯内存结构，MCP Server 重启即清空。设计文档（`design/detailed-design.md §2.1`）描述的文件锁 + 持久化方案未被实现。

**影响**  
MCP Server 重启后，所有 ccId 需要重新通过 `enter_headless_mode` 注册。在 daemon 模式下，MCP Server 崩溃重启后 Claude Code 无法收到消息，直到 agent 重新进入微信模式。

**受影响文件**：`src/http-server.ts`、`design/detailed-design.md`

---

### DESIGN-003 🟡 headless-state.ts 与 project-config.ts 双轨状态文件

**现状**  
- `headless-state.ts` 管理 `.claude/headless.json`（`HeadlessState` 接口）
- `project-config.ts` 管理 `.claude/wecom-aibot.json`（`WechatModeConfig` 接口）
- Hook 检查 `wecom-aibot.json`，但 `headless-state.ts` 的注释说 Hook 检查 `headless.json`

两套状态文件并存，容易出现一个存在另一个不存在的状态，产生歧义。

**受影响文件**：`src/headless-state.ts`、`src/project-config.ts`

---

## 五、修复顺序建议

按照影响范围和依赖关系，建议按以下顺序修复：

```
第一批（独立，低风险）：
  BUG-001  exit SSE 重连（channel-server.ts）
  BUG-002  POST /approve 超时策略（permission-hook.sh）
  BUG-007  pendingApprovals 清理（http-server.ts）
  BUG-008  approval_status 返回 not_found（http-server.ts + hook）
  BUG-012  sendNoReferencePrompt 目标修正（http-server.ts）

第二批（有依赖，需协调）：
  BUG-003  injectApprovalRecord 补充 ccId（client.ts + connection-manager.ts）
  BUG-004  channel-server event 类型区分（channel-server.ts）
  BUG-005  SSE buffer 分包修复（channel-server.ts）

第三批（安全加固）：
  BUG-009  push_notification 白名单（http-server.ts）
  BUG-010  debug 端点环境保护（http-server.ts）

第四批（设计重构，评估工作量后安排）：
  DESIGN-001  审批通知重构
  BUG-006  autoApprove=false 无限循环（permission-hook.sh）
  BUG-011  client.ts 旧版单例清理
```

---

## 附：审计报告索引

| 报告 | 内容 |
|------|------|
| [2026-04-17-audit-report.md](2026-04-17-audit-report.md) | 代码质量、安全性、设计一致性（原始版）|
| [2026-04-17-doc-audit.md](2026-04-17-doc-audit.md) | 设计文档规范性（版本混乱、代码文档不一致）|
| [2026-04-17-approval-flow-audit-v2.md](2026-04-17-approval-flow-audit-v2.md) | 审批链路深度分析（修订版，含两个超时的区分）|
| **AUDIT-FINDINGS.md（本文件）** | 所有发现的汇总，面向 agent 格式化 |
