---
name: headless-mode
description: 当用户说「现在开始通过微信联系」时触发，进入微信交互模式
---

# Headless 微信交互模式

## 重要说明

**本模式使用 `wecom-aibot` MCP 服务器与企业微信通信，不使用其他任何通信方式。**

MCP 服务器地址：`http://127.0.0.1:18963/mcp`（或远程部署地址）

所有消息收发、长轮询、审批通知均通过 wecom-aibot MCP 工具完成。

---

## 启动时自动配置检查

**连接 MCP 后立即执行配置检查**，确保本地环境正确配置：

### 1. 获取配置需求

调用 `mcp__wecom-aibot__get_setup_requirements` 获取所需配置：

```
requirements = mcp__wecom-aibot__get_setup_requirements()
```

返回内容包括：
- `permissions`: 需要的 MCP 工具权限
- `hooks`: PermissionRequest hook 配置
- `skills`: 需要安装的 skill 文件
- `modes`: channel/http 两种模式说明

### 2. 检查并配置权限

检查 `~/.claude/settings.local.json`：

```
1. 读取文件，检查 permissions.allow 是否包含所有 mcp__wecom-aibot__* 权限
2. 如果缺失，添加所需权限
3. 写回文件
```

### 3. 检查并配置 Hook

检查 `~/.claude/settings.local.json`：

```
1. 读取文件，检查 hooks.PermissionRequest 是否存在
2. 如果不存在，添加 hook 配置：
   {
     "hooks": {
       "PermissionRequest": [{
         "matcher": "",
         "hooks": [{ "type": "command", "command": "~/.wecom-aibot-mcp/permission-hook.sh" }]
       }]
     }
   }
3. 写回文件
```

### 4. 检查并安装 Skill

检查 skill 目录：

```
1. 检查 ~/.claude/skills/headless-mode/SKILL.md 是否存在
2. 如果不存在，从 MCP 获取 skill 内容并写入
3. 检查项目目录 .claude/skills/headless-mode/SKILL.md 是否存在
4. 如果不存在，写入项目级 skill
```

### 5. 模式检测

根据 MCP capabilities 决定运行模式：

```
if MCP 支持 'claude/channel' capability:
  mode = 'channel'  # SSE 推送，无需轮询
else:
  mode = 'http'     # 需要轮询 + heartbeat_check
```

调用 `enter_headless_mode` 时传入检测到的 `mode` 参数。

---

## 触发词

「现在开始通过微信联系」「我要离开电脑前」「切换到微信模式」

---

## 启动时自动恢复

**检查文件**：`项目目录/.claude/wecom-aibot.json`

如果该文件存在且 `autoApprove: true`，说明用户期望通过微信交互：

```
1. 读取 wecom-aibot.json 获取 robotName（用于选择机器人）
2. 调用 enter_headless_mode(agent_name, robot_id=robotName)
3. 服务端返回新的 ccId（如 cc-1）
4. 发送消息：【进度】已自动恢复微信模式
5. 开始长轮询
```

**注意**：ccId 由服务端生成，每次进入微信模式都会获得新的 ccId。

---

## MCP 协议说明

**重要**：所有 wecom-aibot 工具通过 MCP (Model Context Protocol) HTTP Transport 调用，**不是直接 HTTP 请求**。

### 工具调用方式

Claude Code 调用 MCP 工具时，会自动处理以下细节：
- **sessionId**: MCP HTTP Transport 要求在 `initialize` 请求时获取 sessionId，后续所有请求必须在 `mcp-session-id` header 中传递。Claude Code **自动处理** sessionId，智能体无需手动管理。
- **工具命名**: 所有工具名称格式为 `mcp__wecom-aibot__<tool_name>`（例如 `mcp__wecom-aibot__send_message`）

### 智能体无需关心的事项

- ❌ 不需要手动获取 sessionId
- ❌ 不需要手动传递 HTTP headers
- ❌ 不需要了解 MCP 协议细节
- ✅ 只需调用 MCP 工具，Claude Code 自动处理底层通信

---

## MCP 工具调用方式

| 功能 | MCP 工具名称 | 必需参数 |
|------|-------------|----------|
| 获取配置需求 | `mcp__wecom-aibot__get_setup_requirements` | 无 |
| 进入微信模式 | `mcp__wecom-aibot__enter_headless_mode` | agent_name, project_dir, mode |
| 发送消息 | `mcp__wecom-aibot__send_message` | cc_id, content |
| 获取消息（HTTP模式） | `mcp__wecom-aibot__get_pending_messages` | cc_id |
| 心跳检查（HTTP模式） | `mcp__wecom-aibot__heartbeat_check` | 无 |
| 退出微信模式 | `mcp__wecom-aibot__exit_headless_mode` | cc_id, project_dir |

---

## 运行模式说明

### Channel 模式（推荐）

**特点**：
- 微信消息通过 SSE notification 自动推送
- Agent 无需轮询，消息自动唤醒
- 实时响应，延迟低

**流程**：
```
微信消息 → MCP → notification 推送 → Agent 自动唤醒 → 处理任务 → 回复结果 → 继续等待
```

**Agent 行为**：
- 进入模式后等待推送（无需主动轮询）
- 收到推送后处理消息
- 完成后回复结果，继续等待下一次推送

### HTTP 模式（兼容）

**特点**：
- Agent 需主动轮询 `get_pending_messages`
- 使用 `heartbeat_check` 保持活跃
- 兼容不支持 Channel 的环境

**流程**：
```
微信消息 → MCP → 消息队列 → Agent 轮询 → 处理任务 → 回复结果 → 继续轮询
```

**Agent 行为**：
- 定期调用 `get_pending_messages(timeout_ms=30000)` 获取消息
- 使用 `/loop` 定期调用 `heartbeat_check` 保持活跃
- 完成后回复结果，立即重新轮询

---

## 进入流程

### 1. 检查配置文件和机器人选择（必须首先执行）

**第一步：检查项目配置文件**

检查项目目录下的 `.claude/wecom-aibot.json`：
- **文件存在且有 robotName** → 直接使用该 robotName，跳过机器人选择
- **文件不存在或没有 robotName** → 需要用户选择机器人

**第二步：获取机器人列表**

调用 `mcp__wecom-aibot__list_robots` 获取所有可用机器人。

**第三步：处理机器人选择**

- **机器人数量 = 1** → 直接使用该机器人
- **机器人数量 > 1 且配置文件中没有 robotName** → **必须使用 AskUserQuestion 让用户选择**

```
使用 AskUserQuestion 让用户选择机器人:
    question: "检测到多个机器人，请选择要使用的机器人"
    options: 每个机器人的名称（从 list_robots 返回的 robots 数组获取）
```

**完整流程示例**：
```
1. 检查项目目录下的 .claude/wecom-aibot.json 是否存在
   - 存在 → 读取 robotName
   - 不存在 → robotName = null
2. 调用 list_robots 获取机器人列表
3. 判断：
   - 如果 robotName 存在 → 使用该 robotName
   - 如果机器人数量 = 1 → 使用该机器人
   - 如果机器人数量 > 1 且没有 robotName → 使用 AskUserQuestion 让用户选择
4. 调用 enter_headless_mode(agent_name, robot_id=确定的机器人名称)
```

**禁止的行为**：
- ❌ 在多机器人场景下自动选择第一个
- ❌ 直接调用 enter_headless_mode 不传 robot_id
- ❌ 假设只有一个机器人而不检查
- ❌ 忽略项目配置文件中的 robotName

### 2. 调用 enter_headless_mode

**重要**：`agent_name` 和 `project_dir` 必须由智能体生成，格式为项目名称或任务名称，不要让 MCP 生成。

```
mcp__wecom-aibot__enter_headless_mode(
  agent_name="<项目名称>",
  robot_id="<机器人名称>",
  mode="<检测到的模式>",  # 'channel' 或 'http'
  project_dir="<项目目录>"
)
```

**参数说明**：
- `agent_name`: **必填**，智能体名称（使用当前项目名称或任务名称）
- `robot_id`: **必填**（多机器人场景），指定机器人名称
- `mode`: **必填**，运行模式：
  - `channel`：SSE 推送，微信消息自动唤醒 Agent（推荐）
  - `http`：轮询模式，需调用 `get_pending_messages` 和 `heartbeat_check`
- `project_dir`: **必填**，项目目录路径

**处理返回值**：
- `entered` → 返回 `ccId`（服务端生成），继续下一步

**注意**：
- ccId 由 MCP Server 自动生成（如 `cc-1`），无需手动指定
- 如果正确执行了步骤 1（机器人选择），不会收到 `select_robot` 状态
- **进入微信模式时，MCP 会自动写入 `.claude/wecom-aibot.json`，设置 `wechatMode: true` 和 `robotName`**

### 3. 写入项目级 Hook（可选）

**注意**：VSCode 扩展可能不完全支持 PermissionRequest Hook。如果审批不生效，可跳过此步骤。

读取当前工作目录的 `.claude/settings.json`（不存在则创建），合并写入：

```json
{
  "hooks": {
    "PermissionRequest": [
      {
        "matcher": "",
        "hooks": [{ "type": "command", "command": "~/.wecom-aibot-mcp/permission-hook.sh" }]
      }
    ]
  }
}
```

保留文件中已有的其他配置，只合并 `hooks.PermissionRequest` 字段。

**重要**：不要添加 `timeout` 字段，VSCode 扩展不支持该配置。超时控制由 hook 脚本内部的轮询机制处理。

### 4. 发确认消息

```
mcp__wecom-aibot__send_message("【进度】已进入微信模式，所有交互将通过企业微信进行。")
```

### 5. 开始长轮询

**核心原则**：轮询永不退出，除非收到明确结束指令（「结束微信模式」「我回来了」）。

```
while (true):
  result = mcp__wecom-aibot__get_pending_messages(timeout_ms=30000)
  if result.messages → 处理消息，然后继续轮询
  if result.timeout  → 立即重新调用（不需要 sleep，不需要任何等待）
```

**timeout 不是停止信号**：
- `timeout: true` 只表示"这 30 秒内没有消息"
- 收到 timeout 后立即重新调用 `get_pending_messages`
- 长轮询会阻塞等待，有消息立即唤醒，无消息等满超时后才消耗 token
- 比短轮询节省约 6 倍 token

---

## 处理用户消息

1. **收到指令后先应答**：立即发送简短确认（如「收到，开始处理...」），让用户知道指令已被接收
2. 理解意图
3. 执行操作（Bash/Edit/Write 等）— Hook 自动处理审批，Claude 阻塞等待用户点击
4. 用 `mcp__wecom-aibot__send_message` 汇报结果
5. 继续轮询

**群聊回复**：`mcp__wecom-aibot__send_message(content, target_user=chatid)`

---

## 任务完成检查（必须执行）

**每次完成用户任务后，必须执行以下检查：**

```python
def on_task_complete():
    # 步骤 1: 检查配置文件
    config = read_file(".claude/wecom-aibot.json")
    
    if config and config.get("autoApprove") == True:
        # 步骤 2: 必须通过 MCP 发送结果
        send_message("【完成】任务结果...")
        
        # 步骤 3: 必须恢复轮询
        while True:
            msg = get_pending_messages(timeout_ms=60000)
            if msg:
                handle_message(msg)
            # timeout 后立即重新调用，不需要 sleep
```

**为什么必须执行**：
- 配置文件存在且 `autoApprove: true` = 用户期望通过微信接收结果
- 不执行 = 用户收不到结果，CC 被判定为离线

**注意**：即使是"compact"、"compacting"等内部任务，完成后也必须检查配置文件并恢复轮询。系统自动触发的 compacting 操作结束后，同样需要执行此检查。

---

## 退出流程

**触发词**：「结束微信模式」「我回来了」「我回电脑了」

1. 调用 `mcp__wecom-aibot__exit_headless_mode(cc_id, project_dir)`
2. **MCP 自动更新 `.claude/wecom-aibot.json` 的 `wechatMode` 为 `false`**
3. 从 `.claude/settings.json` 删除 `hooks.PermissionRequest` 字段（如果之前配置了）
4. 发送 `mcp__wecom-aibot__send_message("【进度】已退出微信模式，恢复终端交互。")`
5. 停止轮询

**「我已经回到电脑旁了」** → 先确认：
```
mcp__wecom-aibot__send_message("【需要确认】是否结束微信模式？回复「是」退出，「否」继续。")
```

---

## 消息格式

**正确格式**：`【标签】消息内容`

| 标签 | 用途 |
|------|------|
| `【进度】` | 里程碑汇报、收到指令确认 |
| `【完成】` | 任务完成，继续等待 |
| `【问题】` | 需用户决策 |
| `【需要确认】` | 二次确认 |

**ccId 路由**：
- 消息前缀由 MCP Server 自动添加（格式：`【ccId】`）
- 多 CC 场景下，用户引用回复时需包含 ccId（如 `【cc-1】`）

---

## 多 CC 消息路由

- **单 CC**：消息直接推送
- **多 CC**：用户需引用回复（引用内容含 `【cc-1】` 等标记路由）