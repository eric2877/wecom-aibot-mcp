# wecom-aibot-mcp 设计变更记录

---

## v2.4.7 - 2026-04-17

### 修复：channel 模式 enter_headless_mode 本地写入 PermissionRequest hook

**问题**：channel 模式下，`enter_headless_mode` 没有在本地写入 PermissionRequest hook，导致审批机制不生效。

**修复**：channel 模式也在项目目录写入 PermissionRequest hook（`{项目}/.claude/settings.json`）。

---

## v2.4.6 - 2026-04-17

### 修复：permission hook 支持远程 channel 模式审批

**问题**：permission hook 脚本在 channel 模式（远程访问）下无法正确发起审批请求。

**修复**：hook 脚本增加对远程 channel 模式的支持，能正确向远端 MCP Server 发送审批请求并轮询结果。

---

## v2.4.5 - 2026-04-17

### 修复：--start/--debug 加入 skipEnsure，防止服务端启动覆盖配置

**问题**：服务端启动时会覆盖已有的自定义 MCP 配置。

**修复**：`--start` / `--debug` 启动时加入 `skipEnsure`，不再写入 `~/.claude.json`。

---

## v2.4.3～v2.4.4 - 2026-04-16

### 功能：server 安装流程拆分 + HTTPS 支持

- `--setup` 命令新增 server 角色安装，独立于 client 角色
- HTTPS 模式支持：向导显示默认证书位置并校验文件存在
- `--setup --channel` 远程安装修复：重新输入 URL、写入完整 MCP 配置

---

## v2.4.2 - 2026-04-15

### 修复：审批请求偶尔无法捕获及重复发送

**问题**：审批卡片在某些场景下发送后无响应，或重复发送。

**修复**：修复 `handleApprovalRequest` 中的竞态条件和重复发送逻辑。

---

## v2.4.0～v2.4.1 - 2026-04-14

### Hook 架构重构

- TaskCompleted hook → Stop hook（Claude Code 只有 Stop 事件）
- Hook 脚本路径统一到 `project-config.ts` 的常量定义
- 不再注册全局 hook，只在项目级 `{项目}/.claude/settings.json` 配置
- HTTP 模式写入 PermissionRequest + Stop hook；channel 模式只写入 PermissionRequest hook

### ccId 注册表内存化

- 废弃文件方案（`cc-registry.json` + 文件锁），改为内存 Map（`http-server.ts`）
- 过期阈值从 14 天改为 30 分钟（`CCID_STALE_TIMEOUT`）
- `registerCcId` 不再拒绝冲突，同名后注册覆盖前者

### 项目配置文件重命名

- `wecom-config.json` → `wecom-aibot.json`（`WechatModeConfig`）
- 新增 `headless.json`（`HeadlessState`，Hook 脚本检查此文件）

### 新增 --setup 命令

新增交互式安装向导，区分 server/client/full 安装角色。

---

## v2.3.4 - 2026-04-14

## v2.1 - 2026-04-12

---

## 1. Channel MCP 透明代理架构

### 问题
HTTP 模式下 agent 经常忘记恢复轮询，导致微信消息无法及时处理。

### 解决方案
Channel MCP 作为 HTTP MCP 的透明代理 + SSE Channel 唤醒。

### 核心原理
```
agent 调用 enter_headless_mode
        ↓
Channel MCP 转发到 HTTP MCP
        ↓
HTTP MCP 返回响应（包含 ccId）
        ↓
Channel MCP 拦截响应
        ↓ 原样转发给 agent
        ↓ 同时建立 SSE 连接
HTTP Server 推送消息到 SSE
        ↓
Channel MCP 收到 SSE 消息
        ↓
notifications/claude/channel → 唤醒 agent
```

### 关键修复
| 问题 | 解决方案 | 文件 |
|------|----------|------|
| Session ID 未传递 | 添加 HTTP MCP session 初始化和传递 | src/channel-server.ts |
| SSE 响应解析失败 | 正确解析 `event: message\n data: {...}` 格式 | src/channel-server.ts |
| SSE 推送逻辑不完整 | 优先检查 SSE 客户端，支持 robotName 匹配 | src/http-server.ts |

---

## 2. Debug 模式优化

### 问题
HTTP MCP 和 Channel MCP 独立实现，debug 模式只能开启其中一个。

### 解决方案
Channel MCP 检测 HTTP MCP 的 debug 标记文件，自动跟随。

### 实现方式
```
HTTP MCP: --debug → 创建 ~/.wecom-aibot-mcp/debug
Channel MCP: 启动时检测 debug 文件 → 启用日志输出
```

### 修改文件
- `src/bin.ts`: Channel MCP 检测 debug 文件逻辑
- `src/tools/index.ts`: HTTP MCP debug 文件创建

---

## 3. 安装模式拆分

### 问题
默认安装只配置 HTTP MCP，远程部署场景需要单独配置 Channel MCP。

### 解决方案
默认安装同时配置 HTTP MCP 和 Channel MCP，支持拆分安装参数。

### 安装模式
| 参数 | 说明 |
|------|------|
| `--upgrade` | 默认安装：HTTP + Channel MCP |
| `--http-only` | 仅启动 HTTP Server（远程部署） |
| `--channel-only` | 仅配置 Channel MCP（必须指定 MCP_URL） |

### MCP 配置
```json
{
  "mcpServers": {
    "wecom-aibot": {
      "type": "http",
      "url": "http://127.0.0.1:18963/mcp"
    },
    "wecom-aibot-channel": {
      "command": "npx",
      "args": ["@vrs-soft/wecom-aibot-mcp", "--channel"],
      "env": { "MCP_URL": "http://127.0.0.1:18963" }
    }
  }
}
```

---

## 4. 心跳机制设计

### 问题
HTTP 模式下 agent 忽略 enter_headless_mode 返回值，导致心跳未启动。

### 解决方案
心跳执行完全写在 SKILL.md 中，不依赖返回值。

### HTTP 模式心跳流程
```
步骤 1: 检查配置文件
步骤 2: 处理返回结果（status: entered）
步骤 3: HTTP 模式立即执行心跳（强制）
        /loop 1m mcp__wecom-aibot__heartbeat_check
        ↓ 提取返回的 job ID（如 "5198a2ad"）
        ↓ 写入 .claude/wecom-aibot.json
步骤 4: 开始轮询
```

### 配置文件记录
```json
{
  "ccId": "wecom-mcp",
  "robotName": "CC",
  "heartbeatJobId": "5198a2ad",  // 心跳 job ID
  "wechatMode": true,
  "autoApprove": true
}
```

### 退出流程
```
1. 读取 heartbeatJobId
2. 执行 CronDelete(heartbeatJobId) 或 /loop stop
3. 删除 heartbeatJobId 字段
4. 调用 exit_headless_mode
```

### 关键限制
- `/loop` 创建的任务 7 天后自动过期
- Session 结束后任务自动停止
- HTTP 模式无法强制保障心跳（依赖 agent 配合）

---

## 5. SKILL.md 重写

### 问题
SKILL.md 语言啰嗦，流程不清晰。

### 解决方案
使用明确步骤编号，语言简洁。

### 流程结构
```
1. 检查配置文件
   a) 有 → 加载配置
   b) 无 → 注册准备：
      1. 生成 ccId
      2. 选择机器人
      3. 选择模式
      4. 调用接口

2. 处理返回结果

3. HTTP 模式：立即执行心跳（强制）

4. 开始轮询
```

---

## 6. get_skill 工具

### 问题
远程部署 HTTP MCP 时，skill 文件无法从本地获取。

### 解决方案
添加 `/skill` HTTP 端点和 `get_skill` MCP 工具。

### 实现方式
- HTTP MCP: `/skill` 端点返回 SKILL.md 文件
- Channel MCP: `get_skill` 工具转发请求
- HTTP MCP: `get_skill` 工具读取本地 skill 文件

### 使用场景
```
远程部署:
  result = mcp__wecom-aibot__get_skill()
  write_file(".claude/skills/headless-mode/SKILL.md", result.content)

本地部署:
  curl http://127.0.0.1:18963/skill > .claude/skills/headless-mode/SKILL.md
```

---

## 7. enter_headless_mode 返回值优化

### 问题
返回值中的心跳提示可能导致 agent 重复执行 `/loop`。

### 解决方案
删除返回值中的心跳提示，完全依靠 SKILL.md 步骤。

### 修改前后对比
```typescript
// 修改前
message: '已进入微信模式(HTTP)。请执行: /loop 1m ...'

// 修改后
message: '已进入微信模式(HTTP)'
```

---

## 8. ccId 冲突处理

### 问题
ccId 自动编号（cc-1, cc-2）不符合用户预期。

### 解决方案
删除自动编号，遇到冲突时提示 agent 改名。

### 实现方式
```typescript
// 返回冲突提示
{
  status: 'ccid_conflict',
  message: '会话名称已被使用，请选择其他名称',
  onlineCcIds: ['cc-1', 'cc-2'],
  hint: '请重新调用 enter_headless_mode 并传入不同的 cc_id'
}
```

---

## 9. Health Endpoint 增强

### 新增字段
```json
{
  "status": "ok",
  "uptime": 123,
  "websocket": { "connected": true, "robotName": "CC" },
  "headless": { "mode": "HEADLESS" },
  "sseClients": 1,  // SSE 连接数
  "ccIds": ["wecom-mcp", "test-channel"]  // 当前注册的 ccId
}
```

---

## 10. 技术细节

### SSE 推送优化
- 优先检查 SSE 客户端（robotName 匹配）
- 简化 HTTP notification 逻辑
- 支持精准 ccId 匹配和广播匹配

### Session ID 管理
- Channel MCP 初始化时获取 HTTP MCP session ID
- 所有转发请求携带 `mcp-session-id` header
- 正确解析 SSE 响应格式

### Debug 标记文件
- 路径: `~/.wecom-aibot-mcp/debug`
- HTTP MCP 创建，Channel MCP 检测
- 退出时删除

---

## 待完成设计

### enter_headless_mode 职责拆分

**问题**: 职责不清晰，混杂注册和连接。

**设计方案**（未实施）:

| 工具 | 职责 |
|------|------|
| `register_cc` | 注册 ccId，创建 wecom-aibot.json（首次） |
| `enter_headless_mode` | 加载配置，建立连接（每次） |

**流程**:
```
首次: register_cc → enter_headless_mode
后续: 检查配置文件 → enter_headless_mode
```

---

## v2.2 - 2026-04-13

---

## 11. CC 注册表重连优化

### 问题

异常断线的 CC 永远留在内存注册表中，同一个 agent 再次调用 `enter_headless_mode` 时被误判为冲突，
导致 SKILL 不断递增编号（材料-1、材料-2...），实际上都是同一个 agent 在重连。

### 设计原则

**`wecom-aibot.json` 的存在即所有权证明。**

同一项目目录下的 agent 始终拥有对应 ccId 的使用权，无需冲突检测。

### 新注册流程

```
enter_headless_mode(cc_id, project_dir)
        ↓
检查 project_dir/.claude/wecom-aibot.json 是否存在且 ccId 匹配
        ↓
  ┌─────┴──────┐
  │  匹配（重连）│  不匹配（首次注册）
  │            │
  └─→ 直接覆盖  └─→ 清理 lastOnline 超时的条目
      更新         再注册新 ccId
      lastOnline
```

### 注册表结构

```typescript
interface CCRegistryEntry {
  robotName: string;
  agentName?: string;
  mode?: 'channel' | 'http';
  projectDir?: string;
  lastOnline: number;  // 新增：Unix 毫秒时间戳
}
```

### 超时清理

- 阈值：`CCID_STALE_TIMEOUT = 30 分钟`
- 时机：首次注册新 ccId 时，顺带清理所有 `lastOnline` 超时的条目
- 重连场景不触发清理（直接覆盖）

### 移除冲突检测

不再返回 `status: ccid_conflict`。`enter_headless_mode` 始终成功，冲突场景通过超时自然解决。

---

## 文件变更汇总

| 文件 | 变更内容 |
|------|----------|
| `src/channel-server.ts` | Session ID 初始化、SSE 解析、get_skill 工具 |
| `src/http-server.ts` | SSE 推送优化、health endpoint 增加 ccIds |
| `src/tools/index.ts` | get_skill 工具、删除心跳返回字段、权限列表更新 |
| `src/bin.ts` | Channel debug 检测、拆分安装参数 |
| `src/config-wizard.ts` | 默认安装双 MCP、channel-only 必须指定 MCP_URL |
| `src/project-config.ts` | 增加 heartbeatJobId 字段定义 |
| `skills/headless-mode/SKILL.md` | 重写为步骤编号、心跳强制执行、退出流程 |

---

## v2.3 - 2026-04-13

---

## 12. Channel 模式修复

### 问题

Channel 模式始终无法唤醒 Claude agent，表现为微信消息到达、SSE 收到消息、notification 显示"发送成功"，但 Claude 不响应。

### 根本原因

三个问题叠加：

**问题 1：缺少 `experimental['claude/channel']` capability 声明**

最根本的问题。未声明此 capability 时，Claude Code 不会注册 notification listener，所有 `notifications/claude/channel` 通知被无声丢弃。

```typescript
// 错误（之前）
capabilities: { tools: {} }

// 正确
capabilities: {
  experimental: { 'claude/channel': {} },
  tools: {},
}
```

**问题 2：notification params 格式错误**

MCP Channels 规范要求 `{ content: string, meta: Record<string, string> }`，之前使用了 `{ level, data }` 非标准格式。

```typescript
// 错误（之前）
params: { level: 'info', data: JSON.stringify(msg) }

// 正确：content 成为 <channel> 标签正文，meta 成为标签属性
params: {
  content: message.content,
  meta: { from, chatid, chattype, cc_id }
}
```

Claude 收到的事件格式：
```
<channel source="wecom-aibot-channel" from="LiuYang" chatid="wr0Q..." chattype="group" cc_id="知识库">
消息内容
</channel>
```

**问题 3：SSE buffer 累积 bug**

SSE 注释行（`: heartbeat`）未被跳过，不断写入 buffer 导致积累。修复：加 `line.startsWith(':')` 判断跳过注释行。

### 解决方案

1. 在 `McpServer` 构造器中声明 `experimental: { 'claude/channel': {} }`
2. 修正 notification params 为 `{ content, meta }` 格式
3. 跳过 SSE `: comment` 行，不写回 buffer
4. 添加 `instructions` 字段告知 Claude 如何处理 `<channel>` 标签

---

## 13. Channel 模式工具前缀路由

### 问题

agent 调用 `mcp__wecom-aibot__enter_headless_mode`（HTTP MCP 直接）而非 `mcp__wecom-aibot-channel__enter_headless_mode`（Channel MCP 版本），导致 channel server 从未拦截到调用，SSE 连接未建立，订阅数 = 0。

### 原因

两个 MCP server 注册了同名工具，agent 默认选择 HTTP MCP 版本。旧 SKILL.md 未区分 Channel 模式下应使用哪个前缀。

### 解决方案

SKILL.md 明确规定：

- **Channel 模式**：使用 `mcp__wecom-aibot-channel__enter_headless_mode`，channel server 拦截后建立 SSE
- **HTTP 模式**：使用 `mcp__wecom-aibot__enter_headless_mode`

---

## 14. heartbeatJobId 持久化（MCP 工具方案）

### 问题

HTTP 模式下，`/loop` 创建的心跳 job ID 需要持久化到 `.claude/wecom-aibot.json`，以便退出时能正确停止定时任务。本地场景可以直接写文件，但远程部署时 agent 无法访问远程服务器的文件系统。

### 解决方案

新增 MCP 工具 `update_heartbeat_job_id(cc_id, job_id)`：

- HTTP MCP 服务端执行，通过 `cc_id` 从注册表查找 `projectDir`
- 调用 `updateWechatModeConfig(projectDir, { heartbeatJobId: job_id })`
- 同时适用本地和远程部署场景

`CCRegistryEntry` 增加 `projectDir?: string` 字段，在 `enter_headless_mode` 时写入。

---

## 15. 群聊消息回复路由

### 问题

收到群聊消息后，`send_message` 未指定 `target_user` 时默认发给配置的 `targetUserId`（单聊），而不是发回群聊。

### 解决方案

`get_pending_messages` 返回的每条消息包含 `chatid`（单聊=用户ID，群聊=群ID，如 `wr0Q...`）。

SKILL.md 明确要求：**回复时必须将 `chatid` 作为 `target_user` 传入**。

```
send_message(cc_id, content, target_user=msg.chatid)
```

---

## 16. CC 注册表 lastOnline 更新时机

### 问题

注册表 `lastOnline` 只在首次注册时写入，长期在线的 CC 实际 lastOnline 不更新，导致超时清理误判。

### 解决方案（待实现）

每次收到消息时（`pushMessageToSubscribers`）更新对应 ccId 的 `lastOnline`。

---

## 17. SKILL.md 流程：先选模式再操作

### 问题

原流程先调用 `mcp__wecom-aibot__list_robots`（HTTP MCP），再询问用户选 Channel 还是 HTTP 模式。用户选 Channel 后，`enter_headless_mode` 虽然改用了 `mcp__wecom-aibot-channel__` 前缀，但 `list_robots` 已经用了 HTTP 前缀，整体 MCP 不一致。

更深的问题：如果 agent 在选模式前就用了 HTTP MCP 的工具，可能误导 agent 后续也用 HTTP 前缀调用 `enter_headless_mode`，导致 channel server 无法拦截。

### 解决方案

**模式决定 MCP 前缀，必须先确定模式。**

新流程：
```
1. 先选模式（Channel / HTTP）→ 确定 MCP 前缀
2. ${MCP}list_robots（用已确定的前缀）
3. ${MCP}enter_headless_mode（同一前缀）
4. 后续所有工具调用保持同一前缀
```

- Channel 模式 → 全程 `mcp__wecom-aibot-channel__`
- HTTP 模式 → 全程 `mcp__wecom-aibot__`

---

## 版本信息

- 版本号: v2.3
- 发布日期: 2026-04-13
- MCP Server 名称: wecom-aibot-channel v2.0.0
- 工具数量: HTTP MCP 14 个、Channel MCP 13 个

---

## v2.3.4 - 2026-04-14

---

## 18. Auth Token 远程部署认证

### 问题

远程 HTTPS 部署时，HTTP Server 需要访问控制，防止未授权访问。

### 设计原则

**Auth Token 与机器人配置无关，它是 HTTP Server 的访问凭证。**

仅在拆分部署场景需要（server 和 channel 分开安装），本地安装无需配置。

### 数据流

```
┌─────────────┐    Authorization header    ┌──────────────────┐
│  Claude Code │ ────────────────────────── │  HTTP Server     │
│  (客户端)    │    Bearer <token>          │  (服务端)        │
└─────────────┘                             │                  │
                                            │  校验 token      │
                                            │  server.json     │
                                            └──────────────────┘
```

### Token 存储位置

| 位置 | 文件 | 用途 |
|------|------|------|
| 服务端 | `~/.wecom-aibot-mcp/server.json` | HTTP Server 读取并校验 |
| 客户端 HTTP | `~/.claude.json` → `headers.Authorization` | Claude Code 自动携带 |
| 客户端 Channel | `~/.claude.json` → `env.MCP_AUTH_TOKEN` | Channel Server 读取 |

### HTTP Server 校验逻辑

位置：CORS/OPTIONS 处理之后，路由分发之前。

```typescript
const authToken = getAuthToken();
if (authToken && url !== '/health') {
  const authHeader = req.headers['authorization'];
  if (authHeader !== `Bearer ${authToken}`) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return;
  }
}
```

**豁免端点**：`/health`（负载均衡探测，无需认证）

**向后兼容**：无 token 配置时，所有请求放行。

### Channel Server 携带 Token

从环境变量 `MCP_AUTH_TOKEN` 读取：

```typescript
const MCP_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN;

function getAuthHeaders(): Record<string, string> {
  if (!MCP_AUTH_TOKEN) return {};
  return { Authorization: `Bearer ${MCP_AUTH_TOKEN}` };
}
```

应用于所有 HTTP 请求：initHttpSession、forwardToHttpMcp、SSE、/skill。

### CLI 命令

| 命令 | 说明 |
|------|------|
| `--set-token my-token` | 直接设置 Token |
| `--set-token` | 交互式输入 Token |
| `--set-token --clear` | 清除 Token |

设置操作同时更新：
1. 服务端 `server.json`
2. 客户端 `~/.claude.json` 中所有 HTTP MCP 配置的 headers

### 远程部署流程

```bash
# 远程服务器
npx @vrs-soft/wecom-aibot-mcp --set-token your-secret-token
npx @vrs-soft/wecom-aibot-mcp --http-only --start

# 本地（首次运行选择"远程服务器"）
npx @vrs-soft/wecom-aibot-mcp
# → 选择安装模式：远程服务器
# → 输入 URL: https://your-server:18963
# → 输入 Token: your-secret-token
```

### MCP 配置格式（远程 + Channel）

```json
{
  "mcpServers": {
    "wecom-aibot": {
      "type": "http",
      "url": "https://remote-server:18963/mcp",
      "headers": {
        "Authorization": "Bearer your-secret-token"
      }
    },
    "wecom-aibot-channel": {
      "command": "node",
      "args": ["bin.js", "--channel"],
      "env": {
        "MCP_URL": "https://remote-server:18963",
        "MCP_AUTH_TOKEN": "your-secret-token"
      }
    }
  }
}
```

### 安全设计

- Token 仅通过 HTTPS 传输（远程部署）
- `/health` 端点不校验（供负载均衡使用）
- 本地部署默认不配置 token
- Token 明文存储在 `server.json`，依赖文件系统权限保护

---

## 文件变更汇总（v2.3.4）

| 文件 | 变更内容 |
|------|----------|
| `src/http-server.ts` | Auth token 校验逻辑 |
| `src/channel-server.ts` | getAuthHeaders() 函数 |
| `src/config-wizard.ts` | getAuthToken/setAuthToken/updateMcpAuthHeaders |
| `src/bin.ts` | --set-token CLI 命令、远程安装向导 |
| `tests/integration/http-server-integration.test.ts` | Auth token 校验测试 |
| `tests/unit/config-wizard.test.ts` | Auth token 函数测试 |