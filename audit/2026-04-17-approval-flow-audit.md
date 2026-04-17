# 审计报告：审批事件链路稳定性与可靠性

> **日期**：2026-04-17
> **版本**：v2.4.7
> **审计类型**：链路稳定性 + 可靠性
> **审计范围**：
> - `permission-hook.sh`（审批发起方）
> - `src/http-server.ts`（审批状态管理）
> - `src/client.ts`（WeChat 事件处理）
> - `src/channel-server.ts`（SSE 中转）
> - `src/message-bus.ts`（事件总线）

---

## 1. 完整审批链路图

```
Claude Code 触发 PermissionRequest
        │
        ▼
permission-hook.sh
  1. 读取 pwd/.claude/wecom-aibot.json（wechatMode、ccId、robotName）
  2. POST /approve { tool_name, tool_input, ccId, robotName }
        │
        ▼
http-server.ts: handleApprovalRequest()
  3. 创建 taskId，存入 pendingApprovals Map
  4. client.sendApprovalRequest() → 发送微信审批卡片
        │
        ▼
WecomClient → 企业微信 API → 用户微信
        │
        │（用户点击「允许/拒绝」）
        ▼
WecomClient.handleApprovalResponse()
  5. approval.resolved = true
  6. publishApprovalEvent(...)
        │
        ├──→ http-server.ts: handleApprovalEvent()
        │      7a. 更新 pendingApprovals.entry.status
        │      7b. SSE 推送 "event: approval" 给 channel-server
        │                │
        │                ▼
        │         channel-server.ts: connectSSE() loop
        │              8. 解析 data: 行
        │              9. 发送 notifications/claude/channel（⚠️ 有问题）
        │
        └──→（同时）
             Hook 轮询 GET /approval_status/:taskId
             http-server.ts: handleApprovalStatus()
               → client.getApprovalResult(taskId)
               → 返回 result 给 Hook（主决策路径）
        │
        ▼
Hook 输出 JSON decision → Claude Code 执行 / 拒绝
```

**关键认知**：  
- Hook 轮询 HTTP 是**主决策路径**（权威）
- SSE `event: approval` 推送是**辅助路径**（通知 Claude agent）
- 两条路径可以独立失败而不影响另一条

---

## 2. 发现问题

### P1 — 高风险

---

#### P1-001：`exit_headless_mode` 中 `sseAbortController` 置空竞态 → 退出后仍重连

**文件**：[src/channel-server.ts:544-550](../src/channel-server.ts#L544)

```typescript
// exit_headless_mode 工具实现
if (sseAbortController) {
  sseAbortController.abort();   // 步骤1: signal.aborted = true
  sseAbortController = null;    // 步骤2: 置 null
  sseConnected = false;
```

退出时，正在运行的 SSE fetch `.catch` 处理器异步触发，检查：

```typescript
}).catch((err) => {
  sseConnected = false;
  if (!sseAbortController?.signal.aborted) {   // ← 此时 sseAbortController 已为 null
    setTimeout(() => connectSSE(ccId), 3000);  // ← !undefined = true → 重连触发！
  }
});
```

**步骤2（置 null）先于 `.catch` 执行**，导致 `sseAbortController?.signal.aborted` 求值为 `undefined`，取反为 `true`，重连逻辑被触发。退出微信模式 3 秒后，SSE 会重新连接到已注销的 ccId endpoint，收到 404，再触发 `.catch` 重连循环，直到进程结束。

**影响**：`exit_headless_mode` 后 channel-server 仍在轮询 `/sse/{ccId}`，产生无效请求，且日志中会持续出现重连失败日志，掩盖真实问题。

---

#### P1-002：Hook `POST /approve` 超时静默放行（安全绕过）

**文件**：[permission-hook.sh:104-114](../../../Users/eric/.wecom-aibot-mcp/permission-hook.sh#L104)

```bash
RESPONSE=$(curl -s -m 10 -X POST "$MCP_BASE_URL/approve" ...)
TASK_ID=$(echo "$RESPONSE" | jq -r '.taskId // empty')
if [[ -z "$TASK_ID" ]]; then
  log_debug "[$(date)] No taskId, exit 0"
  exit 0   # ← 放行！没有经过审批
fi
```

`-m 10` 给 `/approve` 请求设置 10 秒超时。超时原因可能包括：
- MCP Server 瞬间高负载
- 企业微信 API 响应慢（发卡片时 `sendMessage` 超时）
- 网络抖动

超时后 `TASK_ID` 为空，Hook 执行 `exit 0`，Claude Code 将该请求视为**允许**，操作直接执行，完全绕过审批。

**影响**：网络抖动时，任何需要审批的操作（Bash、Write、Edit 等）都会静默通过。特别是在 MCP Server 启动缓慢或高并发审批场景下，这是一个系统性安全漏洞。

---

#### P1-003：channel-server 无法区分审批事件与消息事件

**文件**：[src/channel-server.ts:273-313](../src/channel-server.ts#L273)

HTTP Server 推送两种 SSE 事件：
```
# 微信消息事件
event: message
data: {"type":"wecom_message","robotName":"CC","message":{...},"ccId":"my-project"}

# 审批结果事件
event: approval
data: {"type":"approval_result","taskId":"approval_hook_xxx","result":"allow-once","timestamp":...}
```

channel-server.ts 的 SSE 解析逻辑：
```typescript
if (line.startsWith('data: ')) {
  const msg = JSON.parse(data);
  const message = msg.message || {};      // approval 事件没有 .message 字段
  const notification = {
    content: message.content || JSON.stringify(msg),  // → 变成 '{"type":"approval_result",...}'
    meta: {
      cc_id: msg.ccId || '',    // approval 事件顶层没有 ccId → ''
      from: message.from || '',
      // ...
    }
  };
  mcpServer.server.notification(notification);  // 作为 <channel> 消息推送给 Claude
} else if (line.startsWith('event: ')) {
  logChannel('SSE event type', ...);   // 仅记录日志，不区分处理
}
```

审批结果被转发为 `notifications/claude/channel`，Claude agent 收到：
```xml
<channel source="wecom-aibot-channel" cc_id="" from="" chatid="" chattype="single">
{"type":"approval_result","taskId":"...","result":"allow-once","timestamp":...}
</channel>
```

**问题**：
1. `cc_id` 为空，Claude 无法关联到当前会话
2. 内容是原始 JSON，不是可读消息  
3. Claude agent 可能错误地将审批通知当作用户消息处理，产生干扰响应

**设计意图**：审批结果 SSE 事件原本是为了让 Claude agent 感知审批完成，但当前实现的效果是给 Claude 发了一条"脏消息"。

---

### P2 — 中风险

---

#### P2-001：SSE buffer 对分包 `data:` 行的处理存在消息丢失

**文件**：[src/channel-server.ts:265-322](../src/channel-server.ts#L265)

```typescript
buffer += chunk;
const lines = buffer.split('\n');
buffer = '';              // ← 先清空

for (const line of lines) {
  if (line.startsWith('data: ')) {
    JSON.parse(line.slice(6));   // 如果是半截 JSON → 抛出异常 → 消息丢失
  }
  // ...
  else {
    buffer = line;        // 只有完全不匹配的行才进 buffer
  }
}
```

当 TCP 分包导致 `data: {半截JSON` 到达：
1. 半截内容以 `data: ` 开头 → 进入 data 分支
2. `JSON.parse` 抛出异常 → catch 静默忽略
3. `buffer` 已被清空为 `''`，半截内容丢弃
4. 下一个 chunk 包含 `JSON的后半截}\n\n`，没有 `data: ` 前缀 → 进入 `else { buffer = line }` → 永远不会被解析

**影响**：长消息（> 单个 TCP MSS，约 1400 字节）在分包时会触发此 bug，消息静默丢失，无任何错误日志。微信长文本消息（> 1KB）在高延迟网络下有实际概率触发。

---

#### P2-002：`autoApprove=false` 无限轮询 + MCP Server 崩溃 → Hook 永久挂起

**文件**：[permission-hook.sh:157-175](../../../Users/eric/.wecom-aibot-mcp/permission-hook.sh#L157)

```bash
if [[ "$AUTO_APPROVE" != "true" ]]; then
  while true; do
    sleep 2
    STATUS=$(curl -s -m 3 "$MCP_BASE_URL/approval_status/$TASK_ID" ...)
    RESULT=$(echo "$STATUS" | jq -r '.result // empty')
    # 如果 curl 失败：RESULT="" → 不匹配 allow/deny → 继续循环
    if [[ "$RESULT" == "allow-once" || ... ]]; then ...
    elif [[ "$RESULT" == "deny" ]]; then ...
    fi
    # 无论 curl 成功与否，都不退出
  done
fi
```

当 MCP Server 崩溃后：
- `curl -s -m 3` 超时返回空 → `RESULT=""` → 循环继续
- Hook 进入永久的 sleep 2 + curl 失败循环
- 直到 Claude Code 自身的 Hook 超时（默认600s，可配置）才被强制终止

**影响**：`autoApprove=false` 场景下，MCP Server 一旦崩溃，所有正在等待审批的 Hook 进程永久挂起，Claude Code 所有后续工具调用全部阻塞。Claude Code 的外部超时是最后防线，但 600s 的阻塞期间用户体验极差。

建议加入服务不可达计数器：连续 N 次 curl 失败后切换到 `exit 0` 或发出警告。

---

#### P2-003：`approval_timeout` 接口为 fire-and-forget，与 Hook 输出存在竞态

**文件**：[permission-hook.sh:197-242](../../../Users/eric/.wecom-aibot-mcp/permission-hook.sh#L197)

超时自动决策时：
```bash
# 发送超时通知（后台异步）
curl ... -X POST "$MCP_BASE_URL/approval_timeout/$TASK_ID" ... &   # ← 后台进程

# 立即输出决策
printf '%s\n' '{"hookSpecificOutput":{"decision":{"behavior":"allow"}}}'
exit 0
```

Hook 先将决策输出给 Claude Code，然后**异步**调用 `/approval_timeout` 让 MCP Server 更新状态并发微信通知。

**竞态场景**：如果 Claude Code 读取 Hook 输出极快，而 `/approval_timeout` 调用未完成，则：
1. Claude Code 已执行操作
2. 微信通知延迟发送（用户收到通知时操作已完成）
3. 如果 `/approval_timeout` curl 失败，用户完全不知道超时自动决策发生了

**影响**：用户失去对超时自动审批的感知通道。在 `autoApprove=true` + `autoApproveTimeout` 较短场景下，用户可能在毫不知情的情况下操作被自动执行。

---

#### P2-004：Hook 删除命令检测过于简单，可绕过

**文件**：[permission-hook.sh:183-189](../../../Users/eric/.wecom-aibot-mcp/permission-hook.sh#L183)

```bash
if [[ "$CMD" == rm* ]] || [[ "$CMD" == *" rm "* ]] || [[ "$CMD" == *"-rf"* ]]; then
  IS_DELETE=1
fi
```

可以绕过的命令示例：
- `find . -delete`（find 删除，不含 `rm`）
- `unlink /path/to/file`
- `truncate -s 0 file`
- `shred -u file`
- `python3 -c "import os; os.remove('/path')"`
- `node -e "require('fs').unlinkSync('/path')"`

检测逻辑只针对 `rm` 命令，无法覆盖所有破坏性操作。但这是 `autoApprove=true` 的兜底逻辑，非核心审批路径，用户已选择信任自动审批。

---

### P3 — 设计建议

---

#### P3-001：审批 SSE 路径完全没有作用（设计意图失效）

**文件**：[src/http-server.ts:321-342](../src/http-server.ts#L321)、[src/channel-server.ts:273-312](../src/channel-server.ts#L273)

设计意图：审批完成后，通过 SSE `event: approval` 通知 channel-server，channel-server 再通过 `notifications/claude/channel` 通知 Claude agent，让 agent 知道审批结果。

**实际效果**：
- 结合 P1-003，channel-server 收到 approval 事件后，构造了一个 `cc_id=""` 的 channel notification
- Claude agent 收到一条来源为空的消息
- Claude agent 无法关联到正在等待的工具调用

主决策路径（Hook 轮询 HTTP）完全不依赖 SSE，审批 SSE 路径目前没有实际作用。如果设计目标是让 Claude agent"感知"审批完成（用于日志或 UI），需要重新设计此路径。

---

#### P3-002：`channel-server.ts` 工具编号错误（工具 4 重复）

**文件**：[src/channel-server.ts:392](../src/channel-server.ts#L392) 和 [L400](../src/channel-server.ts#L400)

```typescript
// ============================================
// 工具 4: 检查连接状态         ← 第一个"工具 4"
// ============================================

// ============================================
// 工具 4: 获取待处理消息       ← 第二个"工具 4"（应为工具 5）
// ============================================
```

`get_pending_messages` 被标记为"工具 4"，与 `check_connection` 重复。注释只是标记，不影响运行，但影响代码可读性和维护。

---

#### P3-003：Hook 健康检查与审批发送之间存在 TOCTOU 窗口

**文件**：[permission-hook.sh:65-92](../../../Users/eric/.wecom-aibot-mcp/permission-hook.sh#L65)

```bash
# 时刻 T1: 健康检查
HEALTH=$(curl -s -m 2 "$MCP_BASE_URL/health")
if ! echo "$HEALTH" | jq -e '.status == "ok"'; then
  # 尝试远程服务器...
fi

# ... 若干毫秒后 ...

# 时刻 T2: 发送审批
RESPONSE=$(curl -s -m 10 -X POST "$MCP_BASE_URL/approve" ...)
```

健康检查通过（T1）后，服务可能在 T2 之前崩溃。但这是 TOCTOU（检查-使用时间差），在大多数场景下影响极小，只是理论上的竞态。实际影响通过 P1-002 的 `TASK_ID` 为空检查兜底。

---

## 3. 链路可靠性矩阵

| 路径 | 正常场景 | MCP Server 崩溃 | 网络抖动 | WeChat API 慢 |
|------|---------|----------------|---------|--------------|
| Hook → POST /approve | ✅ | ❌ taskId 空 → 放行 | ⚠️ 10s 超时放行 | ⚠️ 10s 超时放行 |
| Hook 轮询 /approval_status | ✅ | ⚠️ 无限循环（autoApprove=false）| ✅ curl 失败跳过本轮 | ✅ |
| WeChat 事件 → publishApprovalEvent | ✅ | - | ✅ | ✅ |
| SSE approval 推送到 channel-server | ✅ 推出但无用 | ❌ SSE 已断 | ⚠️ 分包丢消息 | ✅ |
| channel-server → notifications | ⚠️ cc_id 空 | - | - | - |

---

## 4. 修复优先级

| ID | 优先级 | 影响 | 修复思路 |
|----|--------|------|---------|
| P1-001 | 高 | exit 后 SSE 重连循环 | 置 null 前先检查 signal，或用独立 flag 标记主动退出 |
| P1-002 | 高 | 审批被静默绕过 | curl 超时改为 `exit 1`（拒绝），或改为明确报错 |
| P1-003 | 高 | approval SSE 通知无效 | channel-server 区分 `event: approval` 与 `event: message` 分别处理 |
| P2-001 | 中 | 长消息分包丢失 | 修复 buffer 逻辑：不清空而是保留处理前缀后的剩余内容 |
| P2-002 | 中 | Hook 永久挂起 | 加入 curl 连续失败计数器，N 次后退出无限循环 |
| P2-003 | 中 | 超时通知竞态 | `curl /approval_timeout` 改为同步调用，等待完成后再输出决策 |
| P2-004 | 低 | 删除检测可绕过 | 仅影响 autoApprove=true 场景，可接受 |
| P3-001 | 低 | 审批 SSE 无实际意义 | 重新设计或移除多余的 SSE 审批通知路径 |

---

## 5. 最关键修复

**P1-002**（审批被静默绕过）是安全问题中最严重的：一旦 MCP Server 响应慢，Hook 超时后直接放行，审批机制形同虚设。

修复方案（最小改动）：
```bash
# 将 exit 0 改为 exit 1（拒绝），使默认行为更保守
if [[ -z "$TASK_ID" ]]; then
  log_debug "[$(date)] No taskId from /approve, denying as safe default"
  printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"审批服务无响应，已拒绝（安全默认行为）"}}}'
  exit 0   # 注意：exit 0 + deny behavior，不是 exit 1
fi
```

---

*审计人：Claude Code 自动审计（只读分析，无代码修改）*
*存档路径：`audit/2026-04-17-approval-flow-audit.md`*
