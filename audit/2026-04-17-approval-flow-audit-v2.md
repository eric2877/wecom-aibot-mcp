# 审计报告（修订版）：审批链路稳定性与可靠性

> **日期**：2026-04-17（修订）
> **版本**：v2.4.7
> **修订说明**：根据用户反馈澄清两个超时机制的区别，补充重连场景下的结构性问题

---

## 1. 首先：两个超时的澄清

Hook 脚本中存在**两个完全不同的超时**，设计文档中没有清晰区分：

```
超时 A（初始化阶段）:
  RESPONSE=$(curl -s -m 10 -X POST "$MCP_BASE_URL/approve" ...)
  └── 10 秒：curl 等待 POST /approve 返回 taskId 的超时

超时 B（等待用户审批阶段）:
  AUTO_APPROVE_TIMEOUT=$(jq -r '.autoApproveTimeout // 600' "$CONFIG_FILE")
  MAX_POLL=$(( (AUTO_APPROVE_TIMEOUT + 1) / 2 ))
  └── 600 秒（10 分钟）：用户响应超时，超时后执行智能代批
      代批判断标准：删除→拒绝；项目内→允许；项目外→拒绝
```

P1-002 的问题**是针对超时 A（10 秒）**，不是超时 B（10 分钟）。超时 B 的设计是正确的，有明确的判断标准。超时 A 没有判断标准，直接 `exit 0` 放行。

---

## 2. 已确认的问题清单

### P1-001：exit_headless_mode 后 SSE 仍会重连（已确认无意义）

**文件**：[src/channel-server.ts:544-550](../src/channel-server.ts#L544)

```typescript
sseAbortController.abort();   // 步骤1: signal.aborted = true
sseAbortController = null;    // 步骤2: 置 null ← 这行先执行

// catch 处理器随后触发：
if (!sseAbortController?.signal.aborted) {  // null?.signal = undefined, !undefined = true
  setTimeout(() => connectSSE(ccId), 3000);  // 重连被触发
}
```

**用户确认**：退出后 SSE 不应重连，重连无意义。

---

### P1-002：POST /approve 的 10 秒超时 → 静默放行（安全绕过）

**文件**：[permission-hook.sh:104-114](../../../Users/eric/.wecom-aibot-mcp/permission-hook.sh#L104)

```bash
RESPONSE=$(curl -s -m 10 -X POST "$MCP_BASE_URL/approve" ...)
TASK_ID=$(echo "$RESPONSE" | jq -r '.taskId // empty')
if [[ -z "$TASK_ID" ]]; then
  exit 0   # ← 放行，操作直接执行，未经审批
fi
```

这是**超时 A**：`POST /approve` 包含 `client.sendApprovalRequest()` 的执行（发送微信卡片），该步骤依赖企业微信 API 网络调用，在网络抖动或 API 限流时可能超过 10 秒。超时后 TASK_ID 为空，所有需要审批的操作被静默放行。

这与超时 B（10 分钟智能代批）是两个独立的风险点，不互相覆盖。

---

### P1-003：审批结果通过 channel 通知 Claude 的设计根本不可靠

**用户反馈**：审批设计经常出问题——审批发送后 Claude 收不到，要不就是发不出来。

这是此次审计的核心问题，需要完整分析根因。

#### 3.1 完整的失败链路

```
用户点击微信审批卡片
        │
        ▼
WecomClient.handleApprovalResponse()
  approval.resolved = true
  approval.result = 'allow-once' / 'deny'
        │
        ├──→【主路径】publishApprovalEvent → handleApprovalEvent
        │           更新 pendingApprovals.entry.status
        │           SSE 推送 "event: approval" → channel-server
        │                │
        │                ▼
        │         channel-server SSE 解析
        │           event: approval 被忽略（只记日志）
        │           data: 行被解析 → notifications/claude/channel
        │             content = '{"type":"approval_result",...}' (原始JSON)
        │             meta.cc_id = '' (空！)
        │           ──→ Claude 收到无法关联的消息
        │
        └──→【Hook 路径】client.getApprovalResult(taskId)
                    Hook 轮询 /approval_status/:taskId
                    ──→ 返回决策给 Claude Code（权威路径）
```

#### 3.2 根本原因一：reconnect 时 ccId 丢失

**文件**：[src/connection-manager.ts:199-213](../src/connection-manager.ts#L199)

```typescript
const pendingApprovals = oldClient.getUnresolvedApprovalMap();
// getUnresolvedApprovalMap() 返回完整 ApprovalRecord（含 ccId）

pendingApprovals.forEach((approval, taskId) => {
  state.client.injectApprovalRecord(taskId, {
    toolName: approval.toolName,
    toolInput: approval.toolInput,
    // ← ccId 没有传入！
  });
});
```

`injectApprovalRecord` 的参数类型：
```typescript
injectApprovalRecord(taskId, partial: { toolName?, toolInput? }): void
```

`ccId` 字段不在 `partial` 类型中，重连后新 client 的审批记录没有 `ccId`。

**影响链**：
1. 用户点击重连后的新卡片
2. `handleApprovalResponse` → `publishApprovalEvent({ ccId: approval.ccId })` → **ccId = undefined**
3. `handleApprovalEvent` 检查 `if (event.ccId)` → **false，不推送 SSE**
4. channel-server 收不到审批结果通知
5. Claude agent 完全不知道审批完成了

#### 3.3 根本原因二：重连后重发审批卡片，用户面对双重卡片

**场景**：
```
T=0: 审批卡片发出（卡片A）
T=5: WebSocket 断开
T=10: 用户点击卡片A → event 未被收到（连接断开）
T=12: WebSocket 重连 → flushPendingMessages() → 重发卡片B（相同 taskId）
T=30: 用户再看到卡片B，但已以为点过了，可能不再点击
T=600: autoApproveTimeout → 智能代批（或无限等待）
```

用户以为自己已经审批，实际上第一次点击丢失，第二张卡片被忽略。

#### 3.4 根本原因三：channel-server 不区分 `event: approval` 和 `event: message`

**文件**：[src/channel-server.ts:313-314](../src/channel-server.ts#L313)

```typescript
} else if (line.startsWith('event: ')) {
  logChannel('SSE event type', { type: line.slice(7) });
  // 只记日志，不区分处理
}
```

SSE 协议的 event 类型（`event: message` vs `event: approval`）被完全忽略，所有 `data:` 内容统一按微信消息处理：

```typescript
const message = msg.message || {};        // approval 事件没有 .message
const notification = {
  content: message.content || JSON.stringify(msg),  // → 原始 JSON 字符串
  meta: {
    cc_id: msg.ccId || '',    // approval 事件顶层没有 ccId → 空
    ...
  }
};
```

Claude agent 收到的 channel 通知：
```xml
<channel source="wecom-aibot-channel" cc_id="" from="" chatid="" chattype="single">
{"type":"approval_result","taskId":"approval_hook_xxx","result":"allow-once","timestamp":1234567890}
</channel>
```

- `cc_id` 为空，Claude 无法关联到当前任务
- 内容是 JSON 字符串，Claude 需要额外解析
- 没有任何用户友好的提示信息

#### 3.5 附：SSE 分包 bug（P2-001 不变）

当微信长消息（> 单 TCP 包）被分包传输时，`data:` 行的 JSON 解析在半截内容上失败，消息静默丢失。此 bug 独立于审批问题存在。

---

## 3. 重新整理的问题优先级

| ID | 问题 | 严重度 | 文件 |
|----|------|--------|------|
| **P1-001** | exit 后 SSE 仍重连 | 高 | channel-server.ts:544 |
| **P1-002** | POST /approve 10s 超时 → 静默放行 | 高 | permission-hook.sh:104 |
| **P1-003a** | reconnect 后 ccId 丢失 → SSE 审批通知失效 | 高 | connection-manager.ts:209 |
| **P1-003b** | channel-server 不区分 event 类型 | 高 | channel-server.ts:313 |
| **P1-003c** | 重连后双重卡片 → 用户点击丢失 | 高 | client.ts:720 + 连接管理逻辑 |
| P2-001 | SSE 分包消息丢失 | 中 | channel-server.ts:269 |
| P2-002 | autoApprove=false 无限循环 + MCP 崩溃 | 中 | permission-hook.sh:159 |
| P2-003 | approval_timeout fire-and-forget | 中 | permission-hook.sh:197 |

---

## 4. 设计层面的根本缺陷

当前审批结果通知 Claude 的路径有两条，但两条都有问题：

```
路径 1（Hook 轮询）：
  正确性：高（taskId 绑定，HTTP 直连）
  但：只能确认 Claude Code 的 hook 拿到了结果
  问题：reconnect 后 client.approvals 里的记录状态可能不同步

路径 2（SSE → channel notification）：
  正确性：低（cc_id 空、内容是原始 JSON、event 类型被忽略）
  问题：三个独立 bug 导致这条路径几乎无效
```

**真正需要的设计**：审批结果通知 Claude agent 应该：
1. 携带 `taskId`（不是 `ccId`）作为关联键
2. 在 channel-server 中明确识别 `event: approval` 并单独处理
3. 格式化为 Claude 可以直接理解的内容，而不是原始 JSON

---

## 5. 三个 P1-003 子问题的最小修复方向

### 修复 P1-003a：reconnect 时保留 ccId

```typescript
// connection-manager.ts
pendingApprovals.forEach((approval, taskId) => {
  state.client.injectApprovalRecord(taskId, {
    toolName: approval.toolName,
    toolInput: approval.toolInput,
    ccId: approval.ccId,    // ← 补充传入 ccId
  });
});
```
同时需要修改 `injectApprovalRecord` 的参数类型以接收 `ccId`。

### 修复 P1-003b：channel-server 区分 event 类型

```typescript
let currentEventType = 'message';   // 跟踪当前事件类型

for (const line of lines) {
  if (line.startsWith('event: ')) {
    currentEventType = line.slice(7).trim();
  } else if (line.startsWith('data: ')) {
    const msg = JSON.parse(data);
    if (currentEventType === 'approval') {
      // 发送审批完成通知，携带 taskId
      mcpServer.server.notification({
        method: 'notifications/claude/channel',
        params: {
          content: `审批结果：${msg.result}`,
          meta: { event_type: 'approval', task_id: msg.taskId, result: msg.result }
        }
      });
    } else {
      // 原有消息逻辑
    }
    currentEventType = 'message';   // 重置
  }
}
```

### 修复 P1-001：exit 后不重连

```typescript
let sseExiting = false;   // 添加退出标记

// exit_headless_mode 中：
sseExiting = true;
sseAbortController.abort();
sseAbortController = null;
sseConnected = false;

// catch 处理器中：
if (!sseExiting && !sseAbortController?.signal.aborted) {
  setTimeout(() => connectSSE(ccId), 3000);
}
```

---

*审计人：Claude Code 自动审计（只读分析，无代码修改）*
*存档路径：`audit/2026-04-17-approval-flow-audit-v2.md`*
