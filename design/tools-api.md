# MCP 工具 API 参考

本文档详细描述 `@various/wecom-aibot-mcp` 提供的所有 MCP 工具。

## 工具列表

| 工具名 | 功能 | 阻塞类型 |
|--------|------|----------|
| `send_message` | 发送消息 | 非阻塞 |
| `send_approval_request` | 发送审批请求 | 非阻塞 |
| `get_approval_result` | 等待审批结果 | **阻塞**（无限等待） |
| `check_connection` | 检查连接状态 | 非阻塞 |
| `get_pending_messages` | 获取待处理消息 | 非阻塞 |
| `get_setup_guide` | 获取安装指南 | 非阻塞 |
| `add_robot_config` | 生成新机器人配置 | 非阻塞 |

---

## 1. send_message

**用途**：向企业微信发送消息（通知用户）

**参数**：
```typescript
{
  content: string;        // 消息内容（支持 Markdown）
  target_user?: string;   // 目标用户 ID（可选，默认使用配置的 TARGET_USER_ID）
}
```

**返回**：
```typescript
{
  content: [{ type: 'text', text: '消息已发送' | '发送失败，请检查连接状态' }]
}
```

**使用场景**：
- 任务进度通知
- 执行结果汇报
- 问题提醒

**示例**：
```typescript
// 发送进度通知
await mcp__wecom-aibot__send_message({
  content: "【进度】已完成文件整理，正在处理配置..."
});
```

---

## 2. send_approval_request

**用途**：发送审批请求（带按钮的模板卡片）

**参数**：
```typescript
{
  title: string;          // 审批标题
  description: string;    // 审批描述（操作详情）
  request_id: string;     // 请求 ID（用于关联审批结果）
  target_user?: string;   // 目标用户 ID（可选）
}
```

**返回**：
```typescript
{
  taskId: string;   // 审批任务 ID（用于 get_approval_result）
  status: 'pending';
}
```

**模板卡片格式**：

微信用户收到如下卡片：

```
┌─────────────────────────────┐
│ 【待审批】删除文件           │  ← title
│                             │
│ 即将删除：/path/to/file     │  ← description
│ 此操作不可恢复              │
│                             │
│ [允许一次] [永久允许] [拒绝] │  ← 按钮列表
└─────────────────────────────┘
```

**按钮含义**：
- `allow-once` - 允许本次操作
- `allow-always` - 永久允许（后续同类操作不再询问）
- `deny` - 拒绝操作

**示例**：
```typescript
const result = await mcp__wecom-aibot__send_approval_request({
  title: "【待审批】删除文件",
  description: "即将删除：/path/to/config.json\n\n此操作不可恢复，请确认。",
  request_id: "del-config-001"
});

// result: { taskId: "approval_del-config-001_1709123456789", status: "pending" }
```

---

## 3. get_approval_result

**用途**：阻塞等待审批结果

**参数**：
```typescript
{
  task_id: string;   // 审批任务 ID（来自 send_approval_request 返回值）
}
```

**返回**：
```typescript
{
  taskId: string;
  result: 'allow-once' | 'allow-always' | 'deny';
}
```

**特性**：
- **无限等待**：timeoutMs = 0，适合 overnight 场景
- 用户离开电脑前，请求会一直阻塞
- 用户在微信点击按钮后立即返回

**示例**：
```typescript
// 发送审批请求
const { taskId } = await mcp__wecom-aibot__send_approval_request({
  title: "【待审批】执行 Bash 命令",
  description: "命令：rm -rf /path/to/dir",
  request_id: "cmd-001"
});

// 阻塞等待用户响应
const { result } = await mcp__wecom-aibot__get_approval_result({ task_id: taskId });

if (result === 'allow-once' || result === 'allow-always') {
  // 执行操作
  Bash("rm -rf /path/to/dir");
  await mcp__wecom-aibot__send_message({ content: "✅ 操作已执行" });
} else {
  // 取消操作
  await mcp__wecom-aibot__send_message({ content: "❌ 操作已取消" });
}
```

---

## 4. check_connection

**用途**：检查企业微信长连接状态

**参数**：无

**返回**：
```typescript
{
  connected: boolean;        // 是否已连接
  defaultTargetUser: string; // 默认目标用户 ID
}
```

---

## 5. get_pending_messages

**用途**：获取用户主动发送的待处理消息（非阻塞）

**参数**：
```typescript
{
  clear?: boolean;   // 获取后是否清空队列（默认 true）
}
```

**返回**：
```typescript
{
  count: number;
  messages: Array<{
    content: string;      // 消息内容
    from: string;         // 发送者用户 ID
    time: string;         // ISO 时间戳
  }>;
  hint: string;           // 提示信息
}
```

**使用方式**：
- 建议轮询间隔 **5 秒**
- 适合监控用户指令（如"停止"、"取消"等）

**示例**：
```typescript
// 定期轮询用户消息
const { messages } = await mcp__wecom-aibot__get_pending_messages({ clear: true });

for (const msg of messages) {
  if (msg.content.includes('停止')) {
    // 用户请求停止
    break;
  }
}
```

---

## 6. get_setup_guide

**用途**：获取安装配置指南（首次安装必读）

**参数**：无

**返回**：完整的安装配置指南文本

---

## 7. add_robot_config

**用途**：生成新机器人 MCP 配置片段

**参数**：
```typescript
{
  instance_name: string;  // MCP 实例名称（如 wecom-aibot-zhangsan）
  bot_id: string;         // 企业微信机器人 ID
  secret: string;         // 机器人密钥
  target_user: string;    // 默认目标用户 ID
}
```

**返回**：JSON 配置片段及添加指南

---

## 审批流程最佳实践

### 标准审批流程

```
1. 检测敏感操作
2. 调用 send_approval_request 发送审批卡片
3. 调用 get_approval_result 阻塞等待
4. 根据结果执行或取消
5. 发送执行结果通知
```

### 审批卡片内容规范

**标题格式**：
- `【待审批】执行 Bash 命令`
- `【待审批】删除文件`
- `【待审批】写入配置`

**描述内容**：
- 具体操作内容
- 影响范围
- 风险提示

**示例**：
```typescript
await mcp__wecom-aibot__send_approval_request({
  title: "【待审批】执行 Bash 命令",
  description: `
即将执行命令：
git push --force origin main

⚠️ 风险提示：
- 此操作会覆盖远程分支
- 可能导致其他人的提交丢失
- 请确认是否继续
  `.trim(),
  request_id: "git-force-push"
});
```

### 敏感操作清单

需要审批的操作类型：

| 类型 | 示例 | 必须审批 |
|------|------|----------|
| 文件删除 | `rm`, `git clean -fd` | ✅ |
| 文件修改 | 写入配置、编辑代码 | ✅ |
| Bash 命令 | 任意 shell 命令 | ✅ |
| 网络请求 | `curl`, `wget` | ✅ |
| Git 操作 | `push`, `reset --hard` | ✅ |
| 读取文件 | `Read`, `Glob` | ❌ |

---

## 错误处理

### 连接断开

```typescript
const { connected } = await mcp__wecom-aibot__check_connection({});
if (!connected) {
  // WebSocket 会自动重连，等待恢复
  await new Promise(r => setTimeout(r, 5000));
}
```

### 发送失败

```typescript
const success = await mcp__wecom-aibot__send_message({ content: "..." });
if (!success) {
  // 重试或等待重连
}
```

---

## 调用示例（Headless 模式）

完整审批流程：

```typescript
// 1. 用户说"现在开始通过微信联系"，进入 headless 模式
// 2. AI 需要执行敏感操作时：

// 发送审批请求
const { taskId } = await mcp__wecom-aibot__send_approval_request({
  title: "【待审批】删除文件",
  description: "即将删除：/path/to/config.json\n此操作不可恢复。",
  request_id: "del-config"
});

// 阻塞等待（用户可能在睡觉，无限等待）
const { result } = await mcp__wecom-aibot__get_approval_result({ task_id: taskId });

// 根据结果执行
if (result === 'allow-once' || result === 'allow-always') {
  await Bash("rm /path/to/config.json");
  await mcp__wecom-aibot__send_message({ content: "✅ 文件已删除" });
} else {
  await mcp__wecom-aibot__send_message({ content: "❌ 操作已取消" });
}
```