---
name: headless-mode
description: 当用户说「现在开始通过微信联系」时触发，进入微信交互模式
---

# Headless 微信交互模式

**触发词**：「现在开始通过微信联系」「我要离开电脑前」「切换到微信模式」

## 进入微信模式流程

> **关键原则**：模式决定 MCP 前缀。Channel 模式全程用 `mcp__wecom-aibot-channel__`，HTTP 模式全程用 `mcp__wecom-aibot__`。**必须先确定模式，再进行后续操作。**

### 1. 确定运行模式

**必须首先用 AskUserQuestion 让用户选择**（或读取 `.claude/wecom-aibot.json` 中已保存的 mode）：

- **Channel 模式**：消息自动推送唤醒，需要用以下命令启动 Claude（研究预览阶段）：
  `claude --dangerously-load-development-channels server:wecom-aibot-channel`
- **HTTP 模式**：心跳轮询，兼容所有环境（API Key、中转服务均可）

> 如果当前会话是通过 `--dangerously-load-development-channels` 启动的，默认选 Channel 模式。

根据选择，确定后续所有工具调用的 **MCP 前缀**：
- Channel 模式 → `MCP = mcp__wecom-aibot-channel__`
- HTTP 模式 → `MCP = mcp__wecom-aibot__`

### 2. 检查配置文件

检查项目目录 `.claude/wecom-aibot.json`：

**a) 文件存在**
- 读取 robotName 和 ccId，直接跳到步骤 4

**b) 文件不存在**
- 执行以下准备步骤：

#### 2.1 生成 ccId

格式：`${项目名}`（如 `wecom-aibot-mcp`）

**禁止自动编号**，如有冲突提示用户改名。

#### 2.2 选择机器人

调用 `${MCP}list_robots`：

- 机器人数量 = 1 → 直接使用
- 机器人数量 > 1 → **必须用 AskUserQuestion 让用户选择**

### 3. 调用 enter_headless_mode

使用步骤 1 确定的 MCP 前缀：

```
${MCP}enter_headless_mode(
  cc_id="<项目名>",
  robot_id="<机器人名称>",
  mode="<channel 或 http>",
  project_dir="<项目目录>"
)
```

例如 Channel 模式：
```
mcp__wecom-aibot-channel__enter_headless_mode(cc_id="知识库", robot_id="CC", mode="channel", project_dir="...")
```

例如 HTTP 模式：
```
mcp__wecom-aibot__enter_headless_mode(cc_id="知识库", robot_id="CC", mode="http", project_dir="...")
```

### 2. 处理返回结果

**返回字段**：
- `status: 'entered'` → 进入成功（重连时直接覆盖，无需改名）

### 3. HTTP 模式：立即执行心跳

**强制步骤，必须执行**：

1. 执行定时任务：
   ```
   /loop 1m mcp__wecom-aibot__heartbeat_check
   ```

   返回示例：
   ```
   已创建定时任务，job ID: abc12345
   每 1 分钟执行一次
   ```

2. 提取返回中的 job ID（如 `abc12345`）

3. 调用 MCP 工具保存 job ID：
   ```
   mcp__wecom-aibot__update_heartbeat_job_id(cc_id="<ccId>", job_id="abc12345")
   ```

**注意**：此步骤必须在进入微信模式后立即执行，否则无法接收消息。

### 4. 开始轮询

**HTTP 模式**：
```
while (true):
  result = mcp__wecom-aibot__get_pending_messages(timeout_ms=30000)
  if result.messages → 处理消息，回复，继续轮询
  if result.timeout → 立即重新调用
```

**Channel 模式**：等待推送，无需轮询。消息到达时 Claude 会被自动唤醒。

---

## 消息处理

### 收到消息后

**HTTP 模式**：
1. 立即发送确认：`mcp__wecom-aibot__send_message(cc_id, "收到...", target_user=<chatid>)`
2. 执行操作（Bash/Edit/Write）
3. 发送结果：`mcp__wecom-aibot__send_message(cc_id, "【完成】...", target_user=<chatid>)`
4. 继续轮询

**Channel 模式**（收到 `<channel>` 标签时）：
1. 立即发送确认：`mcp__wecom-aibot-channel__send_message(cc_id, "收到...", target_user=<chatid>)`
2. 执行操作（Bash/Edit/Write）
3. 发送结果：`mcp__wecom-aibot-channel__send_message(cc_id, "【完成】...", target_user=<chatid>)`

### 回复路由

`get_pending_messages` 返回的每条消息包含：
- `from`：发送者用户 ID
- `chatid`：会话 ID（单聊=用户ID，群聊=群ID，如 `wr0Q...`）
- `chattype`：`single` 或 `group`

**回复时必须将 `chatid` 作为 `target_user` 传入**，确保回复到正确的会话：

```
msg = messages[0]
send_message(cc_id, content, target_user=msg.chatid)
```

- 单聊：`chatid` = 发送者的用户 ID，等同于默认目标，可省略
- 群聊：`chatid` = 群 ID，**必须传入**，否则会发到默认的单聊用户

### 消息格式

- `【进度】` - 里程碑汇报
- `【完成】` - 任务完成
- `【问题】` - 需用户决策
- `【需要确认】` - 二次确认

---

## 任务完成检查

**每次完成任务后必须执行**：

1. 检查 `.claude/wecom-aibot.json`
2. 如果 `autoApprove: true`：
   - 发送结果到微信
   - 恢复轮询（HTTP 模式）

---

## 退出微信模式

**触发词**：「结束微信模式」「我回来了」

1. **停止心跳定时任务**（HTTP 模式）
   
   a) 读取 `.claude/wecom-aibot.json` 中的 `heartbeatJobId`
   
   b) 执行删除：
   ```
   /loop stop <heartbeatJobId>
   ```
   
   c) 删除配置文件中的 `heartbeatJobId` 字段

2. 调用 `mcp__wecom-aibot__exit_headless_mode(cc_id, project_dir)`

3. 删除 PermissionRequest hook

4. 发送退出通知

5. 停止轮询

---

## MCP 工具列表

| 工具 | 用途 | 参数 |
|------|------|------|
| `get_setup_requirements` | 获取配置需求 | 无 |
| `enter_headless_mode` | 进入微信模式 | cc_id, robot_id, mode, project_dir |
| `send_message` | 发送消息 | cc_id, content, target_user(可选) |
| `get_pending_messages` | 获取消息(HTTP模式) | cc_id, timeout_ms |
| `heartbeat_check` | 心跳检查(HTTP模式) | 无 |
| `update_heartbeat_job_id` | 保存心跳 job ID(HTTP模式) | cc_id, job_id |
| `get_skill` | 获取 skill 文件 | 无(远程部署用) |
| `exit_headless_mode` | 退出微信模式 | cc_id, project_dir |

---

## 运行模式对比

| 特性 | Channel 模式 | HTTP 模式 |
|------|-------------|----------|
| 消息接收 | SSE 自动推送 | 主动轮询 |
| 唤醒方式 | notification 自动 | heartbeat + 轮询 |
| 启动要求 | `--dangerously-load-development-channels server:wecom-aibot-channel` | 无特殊要求 |
| 适用 LLM | 仅 Claude | 所有 LLM |