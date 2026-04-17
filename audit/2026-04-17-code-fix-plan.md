# 代码修复实施方案：wecom-aibot-mcp v2.4.7

> **版本**：v2.4.7
> **日期**：2026-04-17
> **文档类型**：实施计划
> **关联审计**：[2026-04-17-audit-report.md](2026-04-17-audit-report.md)
> **状态**：待执行

---

## 总体原则

- 每个修复独立可测试，不依赖其他修复
- 所有修改在本地模式（`--local`）验证后再合并
- 按优先级顺序执行，P1 全部完成后再开始 P2

---

## P1-001：`pendingApprovals` 内存泄漏

**状态**：⬜ 未开始
**文件**：`src/http-server.ts`
**影响**：长期运行内存持续增长，每次审批累积一条永久条目

### 当前代码

```typescript
// L247：ApprovalEntry 无 createdAt 字段
interface ApprovalEntry {
  taskId: string;
  status: 'pending' | 'allow-once' | 'deny';
  timestamp: number;   // ← 有 timestamp，但从未用于过期清理
  tool_name: string;
  tool_input: Record<string, unknown>;
  description: string;
  robotName: string;
  ccId?: string;
}

// L259：Map 永不清理
const pendingApprovals: Map<string, ApprovalEntry> = new Map();

// L1085-1086：状态更新后不删除条目
if (result !== 'pending') {
  entry.status = result as 'allow-once' | 'deny';
}

// L1130-1133：handleApprovalTimeout 处理完后不删除
entry.status = result as 'allow-once' | 'deny';
res.writeHead(200, ...);
res.end(...);
// ← 此处缺少 pendingApprovals.delete(taskId)
```

### 修改方案

**步骤 1**：`ApprovalEntry` 接口添加 `createdAt` 字段（L247）

```typescript
interface ApprovalEntry {
  taskId: string;
  status: 'pending' | 'allow-once' | 'deny';
  timestamp: number;
  createdAt: number;   // ← 新增：写入时间，用于定时清理
  tool_name: string;
  tool_input: Record<string, unknown>;
  description: string;
  robotName: string;
  ccId?: string;
}
```

**步骤 2**：`handleApprovalRequest` 写入 Map 时初始化 `createdAt`（搜索 `pendingApprovals.set` 的位置）

```typescript
pendingApprovals.set(taskId, {
  taskId,
  status: 'pending',
  timestamp: Date.now(),
  createdAt: Date.now(),   // ← 新增
  tool_name,
  tool_input,
  description,
  robotName,
  ccId,
});
```

**步骤 3**：`handleApprovalStatus`（L1085）—— result 变更后延迟删除

```typescript
if (result !== 'pending') {
  entry.status = result as 'allow-once' | 'deny';
  // 延迟 5 分钟删除，给 Hook 最后一次轮询窗口
  setTimeout(() => {
    pendingApprovals.delete(taskId);
    logger.log(`[http] 审批条目已清理: taskId=${taskId}`);
  }, 5 * 60 * 1000);
}
```

**步骤 4**：`handleApprovalTimeout`（L1132 之后）—— 处理完立即删除

```typescript
if (success) {
  entry.status = result as 'allow-once' | 'deny';
  pendingApprovals.delete(taskId);   // ← 新增
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ success: true, taskId, result }));
}
```

**步骤 5**：`initMcpServer`（L281）—— 注册定时兜底清理

```typescript
function initMcpServer(): void {
  subscribeWecomMessage((msg: WecomMessage) => {
    handleWecomMessage(msg);
  });
  subscribeApprovalEvent((event: ApprovalEvent) => {
    handleApprovalEvent(event);
  });

  // ← 新增：每 5 分钟清理超过 15 分钟的审批条目
  setInterval(() => {
    const cutoff = Date.now() - 15 * 60 * 1000;
    let cleaned = 0;
    for (const [id, entry] of pendingApprovals) {
      if (entry.createdAt < cutoff) {
        pendingApprovals.delete(id);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      logger.log(`[http] 定时清理过期审批: ${cleaned} 条`);
    }
  }, 5 * 60 * 1000);
}
```

### 验证

```bash
# 1. 发起一次审批，在微信点击允许
# 2. 等待 5 分钟
# 3. 调用 GET /health 检查 pendingApprovals 计数应为 0
curl http://localhost:18963/health | jq '.pendingApprovals'
```

---

## P1-003：`/push_notification` 允许任意 MCP 方法注入

**状态**：⬜ 未开始
**文件**：`src/http-server.ts`
**位置**：L1283（`handlePushNotification`）
**影响**：无 Auth Token 时，任意本地进程可向所有 Claude Code session 发送任意 MCP 通知

### 当前代码

```typescript
// L1286：method 完全由请求者控制，无白名单
const { method, params } = JSON.parse(body);
// ...
await entry.server.server.notification({
  method: method || 'notifications/message',  // ← 直接使用
  params: params || {}
});
```

### 修改方案

在模块顶层定义白名单常量，在 `handlePushNotification` 函数体内解析 body 之后立即校验：

```typescript
// 模块顶层（handlePushNotification 函数定义之前）
const PUSH_NOTIFICATION_ALLOWED_METHODS = new Set([
  'notifications/message',
  'notifications/progress',
  'notifications/resources/updated',
  'notifications/tools/list_changed',
]);

async function handlePushNotification(req, res) {
  try {
    const body = await readRequestBody(req);
    const { method, params } = JSON.parse(body);

    // ← 新增：method 白名单校验
    const effectiveMethod = method || 'notifications/message';
    if (!PUSH_NOTIFICATION_ALLOWED_METHODS.has(effectiveMethod)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: `不允许的 method: ${effectiveMethod}`,
        allowed: Array.from(PUSH_NOTIFICATION_ALLOWED_METHODS),
      }));
      return;
    }

    // 后续 notification 调用改为 effectiveMethod
    await entry.server.server.notification({
      method: effectiveMethod,
      params: params || {}
    });
```

### 验证

```bash
# 应返回 400
curl -X POST http://localhost:18963/push_notification \
  -H "Content-Type: application/json" \
  -d '{"method":"notifications/evil","params":{}}'

# 应成功
curl -X POST http://localhost:18963/push_notification \
  -H "Content-Type: application/json" \
  -d '{"method":"notifications/message","params":{"level":"info","data":"test"}}'
```

---

## P1-002：SSE 端点缺 ccId 级授权

**状态**：⬜ 未开始
**文件**：`src/http-server.ts`、`src/channel-server.ts`
**位置**：L1193（`handleSSEConnect`）
**影响**：持有合法 token 的任意客户端可订阅其他 CC 的消息流

### 当前代码

```typescript
// L1193-1201：只检查 ccId 是否在注册表，不验证请求方身份
function handleSSEConnect(req, res, url) {
  const ccId = decodeURIComponent(url.replace('/sse/', ''));
  const entry = getCCRegistryEntry(ccId);

  if (!entry) {
    res.writeHead(404, ...);
    return;
  }
  // 直接注册，无请求方身份验证
  sseClients.set(clientId, { res, ccId, robotName: entry.robotName });
```

### 修改方案

**`src/http-server.ts`**（`handleSSEConnect`，L1193 附近）：

```typescript
function handleSSEConnect(req, res, url) {
  const urlObj = new URL(req.url!, 'http://localhost');
  const targetCcId = decodeURIComponent(urlObj.pathname.replace('/sse/', ''));
  const requestCcId = urlObj.searchParams.get('ccId');  // 请求方声明的身份

  const entry = getCCRegistryEntry(targetCcId);
  if (!entry) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end(`CC ${targetCcId} not found`);
    return;
  }

  // ← 新增：请求方 ccId 必须与目标 ccId 一致
  if (requestCcId && requestCcId !== targetCcId) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `无权订阅 ccId: ${targetCcId}` }));
    return;
  }

  const clientId = `${targetCcId}_${Date.now()}`;
  // 后续原有逻辑...
```

**`src/channel-server.ts`**（连接 SSE 时附加 ccId 参数，搜索 `/sse/` 字符串）：

```typescript
// 修改前
const sseUrl = `${httpUrl}/sse/${encodeURIComponent(ccId)}`;

// 修改后
const sseUrl = `${httpUrl}/sse/${encodeURIComponent(ccId)}?ccId=${encodeURIComponent(ccId)}`;
```

### 验证

```bash
# 用错误 ccId 请求 → 应返回 403
curl "http://localhost:18963/sse/project-A?ccId=project-B"

# 正确 ccId 请求 → 应建立 SSE 连接
curl "http://localhost:18963/sse/project-A?ccId=project-A"
```

---

## P2-003：`handleApprovalStatus` 对未知 taskId 返回 `pending`

**状态**：⬜ 未开始
**文件**：`src/http-server.ts` + Hook 脚本
**位置**：L1103-1106
**影响**：MCP Server 重启后 Hook 轮询永不退出，卡满 10 分钟超时

### 当前代码

```typescript
// L1103-1106：未知 taskId 返回 200+pending
logger.log(`[http] pendingApprovals 中未找到 taskId=${taskId}`);
res.writeHead(200, { 'Content-Type': 'application/json' });
res.end(JSON.stringify({ status: 'pending', result: 'pending' }));
```

### 修改方案

**`src/http-server.ts`**（L1103-1106 替换）：

```typescript
// 未找到 → 返回 404，让 Hook 识别"审批已丢失"并退出
logger.log(`[http] pendingApprovals 中未找到 taskId=${taskId}`);
res.writeHead(404, { 'Content-Type': 'application/json' });
res.end(JSON.stringify({ error: 'taskId not found', taskId }));
```

**Hook 脚本**（`~/.wecom-aibot-mcp/permission-hook.sh`，轮询循环处）：

```bash
# 修改后：识别 404 后退出轮询
HTTP_STATUS=$(curl -s -o /tmp/approval_result.json -w "%{http_code}" \
  "http://localhost:18963/approval_status/$TASK_ID")

if [ "$HTTP_STATUS" = "404" ]; then
  # 审批记录不存在（MCP Server 重启），回退默认 UI
  exit 0
fi
```

### 验证

```bash
# 查询不存在的 taskId → 应返回 404
curl -i "http://localhost:18963/approval_status/nonexistent-task-id"
```

---

## P2-004：`headless-state.ts` 与 `project-config.ts` 双轨状态（保守方案）

**状态**：⬜ 未开始
**文件**：`src/headless-state.ts`、`src/project-config.ts`
**影响**：状态双轨可能导致不一致（headless.json 存在但 wecom-aibot.json wechatMode=false）

### 当前状态

| 文件 | 管理模块 | Hook 是否读取 |
|------|---------|------------|
| `.claude/headless.json` | `headless-state.ts` | 代码注释说"是" |
| `.claude/wecom-aibot.json` | `project-config.ts` | architecture.md §7.2 说"是" |

两份文档互相矛盾。

### 修改方案（不改行为，明确分工）

**`src/headless-state.ts` 文件头注释**：

```typescript
/**
 * Headless 状态管理模块
 *
 * 状态存储在项目目录：{projectDir}/.claude/headless.json
 * 全局索引：~/.wecom-aibot-mcp/headless-index.json
 *
 * 职责：记录进入微信模式的时间戳、projectDir、agentName（供全局索引使用）
 *
 * ⚠️  Hook 脚本读取的是 .claude/wecom-aibot.json（wechatMode 字段），
 *     不读取此文件。两个文件分工如下：
 *     - wecom-aibot.json：Hook 条件检查（wechatMode、autoApprove 等）
 *     - headless.json：进入时间戳、全局 projectDir 索引
 */
```

**`src/project-config.ts` 文件头注释**：

```typescript
/**
 * 项目配置管理模块
 *
 * 管理 {project}/.claude/wecom-aibot.json（WechatModeConfig）
 *
 * ⚠️  Hook 脚本在 PermissionRequest 时读取此文件，检查 wechatMode === true。
 *     如果此文件不存在或 wechatMode !== true，Hook 立即放行（exit 0）。
 */
```

### 验证

代码行为无变化，验证注释内容与实际 Hook 脚本读取逻辑一致。

---

## P2-001：`client.ts` 残留旧版单例 `getClient()`

**状态**：⬜ 未开始
**文件**：`src/client.ts`
**位置**：L812-817
**影响**：同名函数歧义，误用旧版单例可能导致逻辑错误

### 当前代码

```typescript
// L812-817：无参数版本，单机器人时代遗留
export function getClient(): WecomClient {
  if (!instance) {
    throw new Error('WecomClient 未初始化，请先调用 initClient');
  }
  return instance;
}
```

### 修改方案

**步骤 1**：搜索所有外部引用

```bash
grep -rn "getClient" src/ --include="*.ts" | grep -v "connection-manager"
```

预期：只有 `client.ts` 自身，其余文件通过 `connection-manager` 获取带 robotName 的版本。

**步骤 2**：若无外部直接引用，直接删除：

```typescript
// 删除以下内容（含关联的 instance 变量）：
let instance: WecomClient | null = null;

export function getClient(): WecomClient {
  if (!instance) {
    throw new Error('WecomClient 未初始化，请先调用 initClient');
  }
  return instance;
}
```

**步骤 3**：若有引用，先加 `@deprecated` 注释，逐一替换为 `connection-manager.getClient(robotName)`：

```typescript
/** @deprecated 使用 connection-manager 的 getClient(robotName) 替代 */
export function getClient(): WecomClient { ... }
```

### 验证

```bash
npx tsc --noEmit
grep -rn "from.*client.*" src/ --include="*.ts" | grep getClient
```

---

## P2-002：HTTPS 模式 CORS `*` 过宽

**状态**：⬜ 未开始
**文件**：`src/http-server.ts`
**位置**：L633、L964
**影响**：HTTPS 模式绑定 `0.0.0.0`，CORS `*` 允许任意来源浏览器脚本跨域调用所有 API

### 当前代码

```typescript
// L633：始终设置 CORS *
res.setHeader('Access-Control-Allow-Origin', '*');

// L964：HTTPS 模式绑定所有网卡
const host = httpsConfig ? '0.0.0.0' : '127.0.0.1';
```

### 修改方案

在 `requestHandler` 顶部（L633 附近），根据 `httpsConfig` 动态设置：

```typescript
const isPublicMode = !!httpsConfig;
if (isPublicMode) {
  // HTTPS 模式：Claude Code 原生请求不需要 CORS，收紧为同源
  res.setHeader('Access-Control-Allow-Origin', 'null');
} else {
  // HTTP 本地模式：绑定 127.0.0.1，影响范围有限
  res.setHeader('Access-Control-Allow-Origin', '*');
}
```

> `httpsConfig` 已通过闭包在 `requestHandler` 内可访问，无需额外传参。

### 验证

```bash
# HTTP 模式不受影响
curl -i http://localhost:18963/health | grep "Access-Control"
```

---

## P2-005：调试端点暴露于生产环境

**状态**：⬜ 未开始
**文件**：`src/http-server.ts`
**位置**：L824（`/debug/enter_headless`）起的所有 `/debug/` 路由
**影响**：`/debug/sampling` 可向 Claude Code 注入任意内容；`/debug/exit_headless` 可清空注册表

### 当前代码

```typescript
// L824：无任何环境检查
if (req.method === 'POST' && url === '/debug/enter_headless') {
  // 直接执行
}
```

### 修改方案

在第一个 `/debug/` 路由之前插入统一拦截块：

```typescript
// 插入位置：第一个 if (... url === '/debug/...') 之前
if (url.startsWith('/debug/')) {
  if (process.env.NODE_ENV === 'production') {
    res.writeHead(404);
    res.end();
    return;
  }

  // /debug/sampling 额外要求配置了 Auth Token
  if (url === '/debug/sampling' && !getAuthToken()) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'debug/sampling 需要配置 Auth Token' }));
    return;
  }
}

// 后续原有 debug 路由保持不变
if (req.method === 'POST' && url === '/debug/enter_headless') { ... }
```

### 验证

```bash
NODE_ENV=production node dist/bin.js --start
curl -i -X POST http://localhost:18963/debug/enter_headless
# 期望：HTTP 404
```

---

## P3-001：`sendNoReferencePrompt` 发给错误目标

**状态**：⬜ 未开始
**文件**：`src/http-server.ts`
**位置**：L618（`sendNoReferencePrompt` 函数末尾）
**影响**：群聊场景下，"请引用回复"提示发给机器人默认用户而非群聊

### 当前代码

```typescript
// L618：sendText 无 target 参数，发给 client 默认的 targetUserId
await client.sendText(reply);
```

### 修改方案

**步骤 1**：确认 `WecomClient.sendText` 签名：

```bash
grep -n "sendText" src/client.ts | head -10
```

**步骤 2**：若支持第二个 `targetUser` 参数，传入原始消息的 `chatid`：

```typescript
// L618 替换为：
await client.sendText(reply, msg.chatid);
```

**步骤 3**：若不支持，改用 `sendTextToChat` 或类似方法（以实际 API 为准）。

### 验证

```bash
# 群聊发消息，验证"请引用回复"提示发到群聊而非私信
```

---

## P3-002：`generateCcId` 不保证唯一性

**状态**：⬜ 未开始
**文件**：`src/http-server.ts`
**位置**：L56-59
**影响**：相同 agentName 的多个 CC 静默覆盖，前者收不到消息

### 当前代码

```typescript
// L56-59：直接返回 agentName，不检查冲突
export function generateCcId(agentName?: string): string {
  const name = agentName ? sanitizeAgentName(agentName) : 'cc';
  return name;
}
```

### 修改方案

```typescript
export function generateCcId(agentName?: string): string {
  const base = agentName ? sanitizeAgentName(agentName) : 'cc';

  // 无冲突：直接使用
  if (!ccIdRegistry.has(base)) return base;

  // 有冲突：自动添加数字后缀（-2, -3, ...）
  for (let i = 2; i <= 99; i++) {
    const candidate = `${base}-${i}`;
    if (!ccIdRegistry.has(candidate)) return candidate;
  }

  // 兜底：使用时间戳保证唯一性
  return `${base}-${Date.now()}`;
}
```

> 修改后需同步检查调用方日志是否有 ccId 不变的假设。

### 验证

```bash
# 两个终端同时进入微信模式，agentName 相同
# 期望：第二个获得 "name-2" 而非覆盖第一个
```

---

## P3-003：`subscribeWecomMessage` 订阅计数异常

**状态**：⬜ 未开始
**文件**：`src/http-server.ts`、`src/message-bus.ts`
**位置**：`http-server.ts` L283（`initMcpServer`）、L445-450（`handleWecomMessage`）
**影响**：HTTP 模式下消息被静默丢弃（`subscriberCount` 恒为 0）

### 问题根因

```typescript
// message-bus.ts L95-97：subscribeWecomMessage 不增加计数
export function subscribeWecomMessage(callback) {
  return wecomMessage$.subscribe(callback);  // ← 不调用 incrementSubscriberCount
}

// http-server.ts L283：initMcpServer 使用全量订阅（不增加计数）
subscribeWecomMessage((msg) => handleWecomMessage(msg));

// http-server.ts L445-450：但消息路由检查 subscriberCount
const subscriberCount = getSubscriberCount(msg.robotName);  // ← 恒为 0
if (subscriberCount === 0) {
  return;  // ← 消息被丢弃！
}
```

### 修改方案（选 B：条件改为检查注册表）

`http-server.ts`（L448）—— 将计数检查改为检查是否有在线 CC：

```typescript
// 修改前
const subscriberCount = getSubscriberCount(msg.robotName);
if (subscriberCount === 0) {
  logger.log('[http] 无订阅者，跳过消息处理');
  return;
}

// 修改后
const ccCount = getCCCount();  // 内存注册表中的 CC 数量
if (ccCount === 0) {
  logger.log('[http] 无在线 CC，跳过消息处理');
  return;
}
const subscriberCount = ccCount;  // 语义替换，保持后续分支逻辑不变
```

> **替代方案 A**：让 `subscribeWecomMessage` 也调用 `incrementSubscriberCount`，但全量订阅无 robotName 上下文，改动更复杂，不推荐。

### 验证

```bash
# HTTP 模式进入微信模式，从微信发送消息
# 日志中不应出现"无订阅者，跳过消息处理"
```

---

## 执行顺序与依赖

```
P1-001（内存泄漏）     ── 独立，最先执行
P1-003（方法注入）     ── 独立，与 P1-001 并行
P2-003（404修复）      ── 独立，需同步更新 Hook 脚本
     ↓
P1-002（SSE授权）      ── 需先确认 channel-server.ts 的 SSE URL 拼接位置
P2-001（client.ts清理）── 需先 grep 确认无外部引用
     ↓
P2-002（CORS）         ── 独立
P2-005（debug端点）    ── 独立
P2-004（双轨注释）     ── 独立，只改注释
     ↓
P3-001（消息目标）     ── 需先确认 sendText API
P3-002（ccId唯一性）   ── 独立
P3-003（订阅计数）     ── 独立，但需运行测试验证消息路由
```

---

## 测试策略

### 单元测试（每个修复后运行）

```bash
npm run test:unit
```

关注：
- `tests/unit/http-server.test.ts`（涵盖 P1-001、P1-003、P2-003、P2-005）
- `tests/unit/tools.test.ts`（涵盖 P3-002）

### 集成测试

```bash
npm run test:integration
```

### 本地端到端验证

```bash
# 以本地模式启动（不连接企业微信）
node dist/bin.js --local --port 18963

# 逐项验证（参照各修复的"验证"节）
```

---

## 风险评估

| 修复项 | 改动大小 | 潜在副作用 | 风险 |
|--------|---------|----------|------|
| P1-001 内存泄漏 | 小（4处） | setTimeout 回调中的删除可能与轮询竞争 | 低 |
| P1-003 方法白名单 | 小（1处） | 若有合法的非白名单 method 调用需扩充 | 低 |
| P1-002 SSE 授权 | 中（2文件） | channel-server URL 变更需同步 | 中 |
| P2-003 404 返回 | 小（1处）+ Hook | Hook 脚本需同步更新，否则旧 Hook 不识别 404 | 中 |
| P2-001 清理单例 | 小（删除） | 需先确认无外部引用 | 低 |
| P2-002 CORS | 小（1处） | HTTPS 模式现有客户端若依赖 CORS * 会失效 | 中 |
| P2-005 debug 端点 | 小（1处） | 现有依赖 debug 端点的脚本需更新 | 低 |
| P2-004 注释 | 最小 | 无运行时影响 | 无 |
| P3-001 消息目标 | 小（1处） | 需确认 sendText API | 低 |
| P3-002 ccId 唯一 | 小（1处） | 现有 CC 的 ccId 不变，新进入的才会变 | 低 |
| P3-003 订阅计数 | 中（逻辑改写） | 路由逻辑变更，需充分测试多 CC 场景 | 中 |

---

*文档生成：2026-04-17*
*状态标记：⬜ 未开始 → 🔄 进行中 → ✅ 已完成 → ⚠️ 有阻塞*
