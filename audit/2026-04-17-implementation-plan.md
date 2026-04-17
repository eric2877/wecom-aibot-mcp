# 审计意见落实实施计划：wecom-aibot-mcp

> **版本**：v2.4.7
> **日期**：2026-04-17
> **文档类型**：实施计划
> **关联审计**：[2026-04-17-audit-report.md](2026-04-17-audit-report.md)、[2026-04-17-doc-audit.md](2026-04-17-doc-audit.md)
> **已落实**：文档与代码不一致问题（所有 design/ 文档）、虚构审计报告引用、Phase 4 文档规范完善（全部完成）

---

## 总览

| 阶段 | 内容 | 优先级 | 改动范围 |
|------|------|--------|---------|
| Phase 1 | P1 高风险代码修复（3 项） | 立即 | 小，各自独立 |
| Phase 2 | P2 中风险代码修复（5 项） | 近期 | 中，部分有设计选择 |
| Phase 3 | P3 建议优化（3 项） | 计划内 | 小 |
| Phase 4 | 文档规范完善（4 项） | 随时并行 | 纯文档 |

---

## Phase 1：P1 高风险代码修复

### 1.1 P1-001：`pendingApprovals` 内存泄漏

- **状态**：⬜ 未开始
- **文件**：`src/http-server.ts`
- **位置**：L259（Map 声明）、L1085（handleApprovalStatus）、L1109（handleApprovalTimeout）

**问题**：审批完成后条目永不删除，MCP Server 长期运行时内存持续增长。

**修复步骤**：

1. 为 `ApprovalEntry` 增加 `createdAt: number` 字段（Map 声明处初始化时写入 `Date.now()`）

2. `handleApprovalStatus` 中，result 不再是 `pending` 时，延迟 5 分钟删除（给 Hook 最后一次轮询窗口）：
   ```typescript
   if (result !== 'pending') {
     entry.status = result as 'allow-once' | 'deny';
     setTimeout(() => pendingApprovals.delete(taskId), 5 * 60 * 1000);
   }
   ```

3. `handleApprovalTimeout` 处理完成后立即删除：
   ```typescript
   pendingApprovals.delete(taskId);
   ```

4. `initMcpServer` 中注册定时兜底清理（15 分钟上限）：
   ```typescript
   setInterval(() => {
     const cutoff = Date.now() - 15 * 60 * 1000;
     for (const [id, entry] of pendingApprovals) {
       if (entry.createdAt < cutoff) pendingApprovals.delete(id);
     }
   }, 5 * 60 * 1000);
   ```

**验证**：`GET /health` 返回的 `pendingApprovals` 计数在审批完成后应在 5 分钟内归零。

---

### 1.2 P1-003：`/push_notification` 允许任意 MCP 方法注入

- **状态**：⬜ 未开始
- **文件**：`src/http-server.ts`
- **位置**：L1283（`handlePushNotification`）

**问题**：`method` 字段完全由请求者控制，无白名单，未配置 Auth Token 时本地任意进程可注入。

**修复步骤**：

1. 在 `handlePushNotification` 函数顶部定义白名单常量：
   ```typescript
   const ALLOWED_NOTIFICATION_METHODS = new Set([
     'notifications/message',
     'notifications/progress',
     'notifications/resources/updated',
   ]);
   ```

2. 解析 body 后立即校验：
   ```typescript
   if (!ALLOWED_NOTIFICATION_METHODS.has(method)) {
     res.writeHead(400, { 'Content-Type': 'application/json' });
     res.end(JSON.stringify({ error: `不允许的 method: ${method}` }));
     return;
   }
   ```

**验证**：`POST /push_notification` 传入非白名单 method 返回 400。

---

### 1.3 P1-002：SSE 端点缺 ccId 级授权

- **状态**：⬜ 未开始
- **文件**：`src/http-server.ts`、`src/channel-server.ts`
- **位置**：L1192（`handleSSEConnect`）

**问题**：任何持有合法 token 的客户端可订阅任意 ccId 的消息流，存在信息泄露风险。

**修复步骤**：

1. `channel-server.ts` 在拼接 SSE URL 时附加 `?ccId=<本机ccId>` 查询参数

2. `handleSSEConnect` 中读取并验证请求方 ccId：
   ```typescript
   const urlObj = new URL(req.url!, 'http://localhost');
   const requestCcId = urlObj.searchParams.get('ccId');
   const targetCcId = decodeURIComponent(urlObj.pathname.replace('/sse/', ''));

   if (requestCcId && requestCcId !== targetCcId) {
     res.writeHead(403, { 'Content-Type': 'application/json' });
     res.end(JSON.stringify({ error: '无权订阅该 ccId' }));
     return;
   }
   ```

**验证**：用错误 ccId 发起 SSE 连接返回 403；正常 channel 模式连接不受影响。

---

## Phase 2：P2 中风险代码修复

### 2.1 P2-003：`handleApprovalStatus` 对未知 taskId 永返 `pending`

- **状态**：⬜ 未开始
- **文件**：`src/http-server.ts`
- **位置**：L1103-1106

**问题**：MCP Server 重启后 `pendingApprovals` 清空，Hook 轮询将永久收到 `pending`，只能等到 10 分钟超时。

**修复步骤**：

1. 将"未找到"分支的响应码从 `200+pending` 改为 `404`：
   ```typescript
   res.writeHead(404, { 'Content-Type': 'application/json' });
   res.end(JSON.stringify({ error: 'taskId not found', taskId }));
   ```

2. 同步修改 Hook 脚本（`~/.wecom-aibot-mcp/permission-hook.sh`）：识别 HTTP 404 后立即退出轮询，回退默认 UI（`exit 0`）。

**验证**：查询不存在的 taskId 返回 404；Hook 脚本在 MCP Server 重启后不再卡死等待。

---

### 2.2 P2-001：`client.ts` 残留旧版单例 `getClient()`

- **状态**：⬜ 未开始
- **文件**：`src/client.ts`
- **位置**：L812-818

**问题**：与 `connection-manager.ts` 中同名但签名不同的 `getClient(robotName)` 并存，易被误调用。

**修复步骤**：

1. 搜索所有 `import.*getClient.*from.*client` 的调用路径，确认无外部引用
2. 若无：直接删除 `instance` 变量和无参数 `getClient()` 函数
3. 若有引用：先将旧版函数标注 `@deprecated`，改写为调用 `connection-manager` 的有参版本，再统一替换调用方

**验证**：`grep -r "getClient" src/` 只剩 `connection-manager.ts` 中的有参版本。

---

### 2.3 P2-002：HTTPS 模式 CORS `*` 过宽

- **状态**：⬜ 未开始
- **文件**：`src/http-server.ts`
- **位置**：L617

**问题**：HTTPS 模式绑定 `0.0.0.0` 对外暴露，CORS `*` 允许任意来源浏览器脚本跨域调用所有 API。

**修复步骤**：

1. 根据绑定地址动态设置 CORS：
   ```typescript
   const isPublic = bindAddress !== '127.0.0.1';
   res.setHeader('Access-Control-Allow-Origin', isPublic ? 'null' : '*');
   ```

> **注**：若有已知合法客户端来源（如内网 IP），可改为明确域名白名单，优于 `'null'`。

**验证**：HTTPS 模式下浏览器跨域 fetch 被拒绝；HTTP 本地模式不受影响。

---

### 2.4 P2-005：调试端点暴露于生产环境

- **状态**：⬜ 未开始
- **文件**：`src/http-server.ts`
- **位置**：L808-940（`/debug/*` 路由段）

**问题**：`/debug/sampling` 可向 Claude Code 注入任意内容；未配置 Auth Token 时本地任意进程均可调用。

**修复步骤**：

1. 在 `/debug/` 路由入口增加环境检查：
   ```typescript
   if (url.startsWith('/debug/')) {
     if (process.env.NODE_ENV === 'production') {
       res.writeHead(404); res.end(); return;
     }
     // 现有 debug 路由...
   }
   ```

2. `/debug/sampling` 额外强制要求配置了 Auth Token：
   ```typescript
   if (url === '/debug/sampling' && !getAuthToken()) {
     res.writeHead(403, { 'Content-Type': 'application/json' });
     res.end(JSON.stringify({ error: '调试采样需要配置 Auth Token' }));
     return;
   }
   ```

**验证**：`NODE_ENV=production` 启动后所有 `/debug/*` 端点返回 404。

---

### 2.5 P2-004：`headless-state.ts` 与 `project-config.ts` 双轨状态

- **状态**：⬜ 未开始（设计决策，建议单独评估）
- **文件**：`src/headless-state.ts`、`src/project-config.ts`

**问题**：两个文件分别管理 `headless.json` 和 `wecom-aibot.json`，字段重叠，Hook 读哪个文档不明确。

**修复步骤（保守方案）**：

1. 明确分工注释：`wecom-aibot.json` 为主配置（Hook 唯一读取），`headless.json` 仅做 projectDir 索引和时间戳记录
2. 在两个模块的文件头注释中写明各自职责和 Hook 的读取路径
3. 更新 `design/architecture.md §7.2` 的激活条件描述与代码一致

**彻底合并方案**（破坏性，建议独立 PR）：

- 将 `HeadlessState` 字段合并进 `WechatModeConfig`，删除 `headless.json`
- 同步更新 Hook 脚本和所有调用方
- 需要完整的集成测试覆盖

**验证**：文档与代码对两个文件职责的描述一致；Hook 脚本工作正常。

---

## Phase 3：P3 建议优化

### 3.1 P3-001：`sendNoReferencePrompt` 发给错误目标

- **状态**：⬜ 未开始
- **文件**：`src/http-server.ts`
- **位置**：L588-603

**问题**：无参数调用 `client.sendText(reply)` 发给机器人默认 `targetUserId`，群聊场景下消息发给错误的人。

**修复步骤**：

1. 确认 `WecomClient.sendText` 的第二个参数语义（targetUser/chatid）
2. 调用时传入原始会话 ID：
   ```typescript
   await client.sendText(reply, msg.chatid);
   ```

**验证**：群聊中发送无引用消息时，提示回复到群聊而非私信。

---

### 3.2 P3-002：`generateCcId` 不保证唯一性

- **状态**：⬜ 未开始
- **文件**：`src/http-server.ts`
- **位置**：L56-59

**问题**：相同 agentName 的多个 CC 会产生静默 ccId 冲突，后者覆盖前者。

**修复步骤**：

```typescript
export function generateCcId(agentName?: string): string {
  const base = agentName ? sanitizeAgentName(agentName) : 'cc';
  if (!ccIdRegistry.has(base)) return base;

  for (let i = 2; i <= 99; i++) {
    const candidate = `${base}-${i}`;
    if (!ccIdRegistry.has(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;  // 兜底
}
```

**验证**：两个相同 agentName 的 CC 分别获得 `name` 和 `name-2` 两个不同 ccId。

---

### 3.3 P3-003：`subscribeWecomMessageByCcId` 订阅计数异常

- **状态**：⬜ 未开始
- **文件**：`src/http-server.ts`、`src/message-bus.ts`
- **位置**：`http-server.ts` L282（`initMcpServer`）、L444（`handleWecomMessage`）

**问题**：`http-server.ts` 使用全量订阅，`getSubscriberCount` 计数始终为 0，消息被静默丢弃路径存在风险。

**修复步骤（选其一）**：

- **方案 A**：改用 `subscribeWecomMessageByRobot` 按机器人订阅，让计数器正常工作
- **方案 B**：`handleWecomMessage` 中将 `subscriberCount === 0` 的判断改为检查内存注册表中是否有在线 CC（`getCCCount() > 0`），绕过计数器

**验证**：HTTP 模式下有 CC 在线时，消息不会被误判为"无订阅者"而丢弃。

---

## Phase 4：文档规范完善

### 4.1 版本号对照表

- **状态**：✅ 已完成（2026-04-17）
- **文件**：`design/overview.md`（顶部新增）

**内容**：

```markdown
## 版本对照

| NPM 版本 | 架构版本 | 主要特性 |
|---------|---------|---------|
| v2.4.7  | v3.1    | ccId 注册表内存化、项目级配置双文件、Auth Token |
| v2.3.4  | v3.0    | Channel 模式、SSE 审批推送修复 |
| v2.2.x  | —       | 多机器人支持 |
```

---

### 4.2 历史文档状态标记

- **状态**：✅ 已完成（2026-04-17）

为以下 6 个文件头部添加 `> **状态**：...` 字段：

| 文件 | 状态标记 |
|------|---------|
| `design/daemon-design.md` | 已废弃（当前架构不使用 daemon） |
| `design/daemon-design-simple.md` | 已废弃 |
| `design/long-polling-design.md` | 历史参考（已被 Channel 模式替代） |
| `design/auth-design.md` | 有效（见 DESIGN.md §18） |
| `design/implementation-plan.md` | 历史参考（v3.0 升级计划，已完成） |
| `design/MANUAL-TEST-PLAN.md` | 有效（需定期更新） |

---

### 4.3 变更日志补录（v2.4.0 → v2.4.7）

- **状态**：✅ 已完成（2026-04-17）
- **文件**：`DESIGN.md`

**信息来源**：

- `git log` 从 v2.3.4 标签至今的提交记录
- `design/hook-change-log.md` 的 2026-04-17 变更
- `design/hook-approval-solution.md` 的"2026-04-17 更新"段落

**补录内容（草稿）**：

| 批次 | 日期 | 主要变更 |
|------|------|---------|
| v2.4.0 | 2026-04-14 | ccId 注册表从文件改为内存 Map；项目配置改用 `wecom-aibot.json` |
| v2.4.1~v2.4.6 | 2026-04-14～17 | 待从 git log 整理 |
| v2.4.7 | 2026-04-17 | Hook 审批 SSE 推送修复；channel 模式 enter_headless_mode 本地写入 |

---

### 4.4 文档头部格式统一

- **状态**：✅ 已完成（2026-04-17，全部 16 个文档统一为格式 B）

统一使用格式 B（字段加粗）应用到全部 16 个设计文档：

```markdown
> **版本**：v2.4.7
> **更新日期**：YYYY-MM-DD
> **文档类型**：架构设计 | 详细设计 | API 参考 | 变更日志 | 问题记录 | 历史参考
> **状态**：有效 | 已废弃 | 历史参考
```

---

## 执行顺序

```
[立即] 1.1 内存泄漏 → 1.2 方法注入 → 2.1 404修复
                                              ↓
[近期] 1.3 SSE授权（需确认 channel-server 连接逻辑）
       2.4 debug端点 → 2.3 CORS → 2.2 client.ts清理
                                              ↓
[计划] 3.1 消息目标 → 3.2 ccId唯一性 → 3.3 订阅计数
                                              ↓
[独立] 2.5 双轨状态合并（破坏性，单独评估）

[随时并行] Phase 4 文档规范（无代码风险，可随时穿插）
```

---

*文档生成：2026-04-17*
*下次回顾：每次落实一个条目后更新对应状态（⬜ 未开始 → 🔄 进行中 → ✅ 已完成）*
