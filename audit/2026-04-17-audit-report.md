# 审计报告：wecom-aibot-mcp v2.4.7

> **日期**：2026-04-17
> **版本**：v2.4.7（架构 v3.1）
> **审计类型**：设计一致性 + 代码质量 + 安全性
> **审计范围**：src/http-server.ts · src/client.ts · src/message-bus.ts · src/headless-state.ts · src/project-config.ts · src/tools/index.ts · src/index.ts + design/ 文档

---

## 1. 总体评估

项目整体架构清晰，设计文档较完整，v3.1 引入的 ccId 注册表 + 项目级配置思路合理。但存在以下典型问题：
- 旧模块未彻底清理（遗留代码影响可读性和潜在行为）
- 部分安全防护存在缺口（无认证端点、CORS 配置不当）
- 内存管理存在泄漏点
- 设计文档与代码存在若干不一致

---

## 2. 发现问题

### P1 — 高风险

---

#### P1-001：`pendingApprovals` Map 永不清理（内存泄漏）

**文件**：[src/http-server.ts:259](../src/http-server.ts#L259)

```typescript
const pendingApprovals: Map<string, ApprovalEntry> = new Map();
```

`pendingApprovals` 贯穿整个 `http-server.ts`，在 `handleApprovalRequest`、`handleApprovalStatus`、`handleApprovalTimeout` 中写入，但**从不清理**：

- `handleApprovalStatus`（L1085）中将 status 更新为 `allow-once` 或 `deny` 后，条目仍保留
- `clearCcIdRegistry`（L210）只清理 ccId 注册表，不清理 pendingApprovals
- `WecomClient.cleanupMessages`（client.ts L706）清理 client 内部的 approvals Map，但 http-server.ts 的 `pendingApprovals` 不受影响

**影响**：MCP Server 长期运行时（如作为 daemon），每次审批都累积一条永久条目，导致内存持续增长。

**对比**：`WecomClient.approvals`（client.ts）有 `cleanupMessages` 定期清理，设计完整；`http-server.ts` 的 `pendingApprovals` 缺少对等机制。

---

#### P1-002：SSE 端点 `/sse/{ccId}` 无授权校验

**文件**：[src/http-server.ts:780-783](../src/http-server.ts#L780)

```typescript
if (req.method === 'GET' && url.startsWith('/sse/')) {
  handleSSEConnect(req, res, url);
  return;
}
```

Auth token 校验（L632-638）在此路由**之前**执行，所以 SSE 端点也受 token 保护。但 `handleSSEConnect`（L1192）内部只检查 ccId 是否在注册表中，**未校验调用方是否有权订阅该 ccId 的消息**：

```typescript
function handleSSEConnect(req, res, url) {
  const ccId = decodeURIComponent(url.replace('/sse/', ''));
  const entry = getCCRegistryEntry(ccId);
  if (!entry) { res.writeHead(404); return; }
  // 直接注册，无调用方身份验证
  sseClients.set(clientId, { res, ccId, robotName: entry.robotName });
```

**影响**：任何知道 ccId 名称的持有合法 token 的客户端，都能订阅其他 CC 的消息流（包括审批结果）。在 token 共享或泄漏场景下，存在信息泄露风险。

---

#### P1-003：`/push_notification` 允许注入任意 MCP 方法（无 Auth 时）

**文件**：[src/http-server.ts:1283-1315](../src/http-server.ts#L1283)

```typescript
const { method, params } = JSON.parse(body);
// ...
await entry.server.server.notification({ method, params });
```

`method` 字段完全由请求者控制，没有白名单限制。当 `getAuthToken()` 返回 `null`（未配置 Auth Token 时），任何能访问 `127.0.0.1:18963` 的本地进程都可以向所有活跃 MCP session 发送任意方法的通知，可能影响 Claude Code 客户端行为。

---

### P2 — 中风险

---

#### P2-001：`src/client.ts` 残留旧版单例 `getClient()`

**文件**：[src/client.ts:812-818](../src/client.ts#L812)

```typescript
// 单例实例
let instance: WecomClient | null = null;

export function getClient(): WecomClient { ... }   // 无参数，单机器人时代
```

多机器人架构的实际入口在 `src/connection-manager.ts`：
```typescript
export async function getClient(robotName: string): Promise<WecomClient | null>
```

`src/index.ts`（L18）也从 `connection-manager` 导出 `getClient`，覆盖了 `client.ts` 的版本。但 `src/client.ts` 中残留的单例 `getClient`（无参数版本）仍然被导出（L818），带来两个问题：

1. **代码混淆**：同名但签名不同的两个函数，维护者容易混淆
2. **潜在误调用**：若有代码（测试或未发现的路径）直接 import `client.ts` 而非 `connection-manager.ts`，拿到的是旧版单例，逻辑错误但无报错

---

#### P2-002：HTTPS 模式下 CORS 策略过宽

**文件**：[src/http-server.ts:617-621](../src/http-server.ts#L617)

```typescript
res.setHeader('Access-Control-Allow-Origin', '*');
```

HTTP 模式下服务绑定 `127.0.0.1`（L964），CORS `*` 影响范围有限。但 HTTPS 模式下服务绑定 `0.0.0.0`（L964），对外暴露，CORS `*` 允许任意来源的浏览器脚本跨域调用所有 API（包括 `/approve`、`/mcp`）。

---

#### P2-003：`handleApprovalStatus` 对未知 taskId 永远返回 `pending`

**文件**：[src/http-server.ts:1100-1107](../src/http-server.ts#L1100)

```typescript
// 没找到对应的待处理审批，返回 pending
res.writeHead(200, ...);
res.end(JSON.stringify({ status: 'pending', result: 'pending' }));
```

Hook 脚本在创建审批后，以 2 秒间隔轮询 `/approval_status/:taskId`。若 `pendingApprovals` Map 在某种异常场景下丢失了该 taskId（如 MCP Server 重启），Hook 将**永久收到 `pending`**，无法感知丢失，只能等到 Hook 超时（10 分钟）。

更合理的设计是返回 `404`，让 Hook 识别"审批已丢失"并退出或重新发起。

---

#### P2-004：`headless-state.ts` 与 `project-config.ts` 双轨状态文件

**文件**：
- [src/headless-state.ts:31](../src/headless-state.ts#L31)（状态文件：`.claude/headless.json`）
- [src/project-config.ts:37](../src/project-config.ts#L37)（配置文件：`.claude/wecom-aibot.json`）

`headless-state.ts` 管理 `{project}/.claude/headless.json`，接口为 `HeadlessState`：
```typescript
interface HeadlessState {
  projectDir, timestamp, agentName, autoApprove, robotName
}
```

`project-config.ts` 管理 `{project}/.claude/wecom-aibot.json`，接口为 `WechatModeConfig`：
```typescript
interface WechatModeConfig {
  robotName, wechatMode, ccId, autoApprove, autoApproveTimeout, heartbeatJobId
}
```

设计文档（architecture.md §10）只提到 `wecom-aibot.json`，但代码中两个文件都存在并被使用。Hook 脚本检查哪个文件来判断是否在微信模式？根据 architecture.md §7.2 描述，Hook 读取 `{pwd}/.claude/wecom-aibot.json` 检查 `wechatMode == true`，但 `headless-state.ts` 的文档注释写的是"Hook 脚本直接检查 `$(pwd)/.claude/headless.json`"。

**影响**：状态双轨可能导致状态不一致——`headless.json` 存在但 `wecom-aibot.json` 中 `wechatMode: false`，或反之。

---

#### P2-005：调试端点暴露于生产环境

**文件**：[src/http-server.ts:808-940](../src/http-server.ts#L808)

以下端点没有任何生产环境检查（如 `NODE_ENV`），仅依赖 Auth Token 保护：

| 端点 | 风险 |
|------|------|
| `POST /debug/enter_headless` | 注入任意 ccId 到注册表 |
| `POST /debug/exit_headless` | 清空整个 ccId 注册表 |
| `POST /debug/test_message` | 伪造微信消息推送到任意 ccId |
| `POST /debug/disconnect/:robot` | 断开指定机器人连接 |
| `POST /debug/reconnect/:robot` | 强制触发重连 |
| `POST /debug/sampling` | 通过 MCP createMessage 向 LLM 注入内容 |

`/debug/sampling` 尤其敏感：可通过 `createMessage` 向 Claude Code 发送任意内容，如果未配置 Auth Token，任意本地进程均可调用。

---

### P3 — 建议优化

---

#### P3-001：`sendNoReferencePrompt` 推送给错误目标

**文件**：[src/http-server.ts:588-603](../src/http-server.ts#L588)

```typescript
const client = await getClient(msg.robotName);
await client.sendText(reply);  // 发给 client 的 targetUserId
```

`getClient(robotName)` 返回的 `WecomClient` 的 `sendText` 无 targetUser 参数时，发给 `this.targetUserId`（机器人默认用户）。但发送消息的用户 `msg.from_userid` 可能不是 `targetUserId`（例如群聊场景），提示信息会发给错误的人。

正确做法应传入 `msg.chatid` 作为回复目标。

---

#### P3-002：`generateCcId` 不保证唯一性

**文件**：[src/http-server.ts:56-59](../src/http-server.ts#L56)

```typescript
export function generateCcId(agentName?: string): string {
  const name = agentName ? sanitizeAgentName(agentName) : 'cc';
  return name;  // 直接返回名称，不添加编号
}
```

注释"不自动编号"，但若两个不同 CC 使用相同的 `agentName`（或都使用默认值 `'cc'`），会导致 ccId 冲突。虽然 `registerCcId` 允许相同 ccId 的覆盖（L193），但这意味着后注册的 CC 会静默替换前一个，前者再也收不到消息。

---

#### P3-003：`message-bus.ts` 中 `subscribeWecomMessageByCcId` 未被主路由使用

**文件**：[src/message-bus.ts:125-137](../src/message-bus.ts#L125)

`subscribeWecomMessageByCcId` 提供了带订阅计数的 ccId 级过滤订阅，是为 HTTP 多 CC 模式设计的高级接口。但 `http-server.ts` 的 `handleWecomMessage` 并未使用它，而是通过 `subscribeWecomMessage`（全量订阅）+ 内部 if/else 路由实现。

订阅计数 `getSubscriberCount(robotName)` 在 `handleWecomMessage`（L444）中被查询，但由于 http-server.ts 使用全量订阅而非 `subscribeWecomMessageByRobot`，**计数器始终为 0**（除非 `tools/index.ts` 中有单独订阅）。

结果：HTTP 模式下当 `subscriberCount === 0`（L447），消息被静默丢弃，不进入多订阅者路由。需要确认 `tools/index.ts` 的 `get_pending_messages` 工具是否会调用 `subscribeWecomMessageByRobot` 增加计数。

---

#### P3-004：文档版本与代码版本不一致

| 文件 | 声明版本 |
|------|---------|
| `design/overview.md` | 架构版本 v3.1 |
| `design/architecture.md` | 文档版本 v2.4.0 |
| `package.json` | v2.4.7 |

三份文件的版本号含义不同，没有统一说明，可能引起混淆。

---

#### P3-005：`architecture.md` 中的审计记录与实际目录不符

**文件**：[design/architecture.md:499](../design/architecture.md#L499)

```
## 12. 审计修复概要
基于 `audit/` 目录下 7 份审计报告，共发现 58 个问题，已全部修复。
```

但 `audit/` 目录在本次审计前为空目录，7 份历史报告未找到。无法验证"58 个问题已全部修复"的声明。

---

## 3. 总结

| 优先级 | 数量 | 主要类别 |
|--------|------|---------|
| P1（高风险） | 3 | 内存泄漏、SSE 授权缺口、MCP 注入 |
| P2（中风险） | 5 | 遗留代码、CORS、状态双轨、调试端点 |
| P3（建议） | 5 | 路由准确性、唯一性、消息丢失、文档 |

**最优先修复**：P1-001（pendingApprovals 泄漏）和 P1-003（push_notification 注入），风险最直接且修复成本低。P1-002（SSE 授权）需要明确多租户场景的安全边界后再设计解决方案。

---

*审计人：Claude Code 自动审计（只读分析，无代码修改）*
*存档路径：`audit/2026-04-17-audit-report.md`*
