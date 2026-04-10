---
name: headless-mode
description: 当用户说「现在开始通过微信联系」时触发，进入微信交互模式
---

# Headless 微信交互模式

## 重要说明

**本模式使用 `wecom-aibot` MCP 服务器与企业微信通信，不使用其他任何通信方式。**

MCP 服务器地址：`http://127.0.0.1:18963/mcp`

所有消息收发、长轮询、审批通知均通过 wecom-aibot MCP 工具完成。

## 触发词

「现在开始通过微信联系」「我要离开电脑前」「切换到微信模式」

---

## MCP 工具列表

| 功能 | MCP 工具名称 | 必需参数 |
|------|-------------|----------|
| 进入微信模式 | `mcp__wecom-aibot__enter_headless_mode` | cc_id, project_dir |
| 发送消息 | `mcp__wecom-aibot__send_message` | cc_id, content |
| 获取消息（长轮询） | `mcp__wecom-aibot__get_pending_messages` | cc_id |
| 退出微信模式 | `mcp__wecom-aibot__exit_headless_mode` | cc_id, project_dir |
| 列出机器人 | `mcp__wecom-aibot__list_robots` | 无 |

**重要**：`send_message` 会自动在消息头部添加 `【ccId】` 标识。
- 例如：调用 `send_message(cc_id="plugin_generator", content="任务完成")`
- 实际发送：`【plugin_generator】任务完成`
- 这确保多对一场景下用户能区分不同项目

---

## Hook 机制

### TaskCompleted Hook（自动恢复轮询）

**位置**：`~/.wecom-aibot-mcp/task-completed-hook.sh`

**触发时机**：每次任务完成时自动执行

**作用**：检查配置文件，决定是否需要恢复微信消息轮询

**检查逻辑**：

```
1. 检查 $(pwd)/.claude/wecom-aibot.json 是否存在
   - 不存在 → exit 0 (允许完成)

2. 检查 wechatMode == true
   - false → exit 0 (允许完成)

3. 检查 autoApprove == true
   - false → exit 0 (允许完成)

4. 检查 MCP Server 是否在线 (curl /health)
   - offline → exit 0 (允许完成)

5. 读取 ccId
   - 无 ccId → exit 0 (允许完成)

6. 全部条件满足 → exit 2 (阻止完成)
   - 输出提示: "任务已完成，请调用 mcp__wecom-aibot__get_pending_messages(cc_id=<ccId>, timeout_ms=30000) 恢复微信消息轮询"
```

**Exit Code 说明**：

| Exit Code | 含义 | 智能体行为 |
|------------|------|-----------|
| 0 | 允许完成 | 正常结束任务 |
| 2 | 阻止完成 | 调用 `get_pending_messages` 恢复轮询 |

**配置文件结构** (`项目目录/.claude/wecom-aibot.json`):

```json
{
  "wechatMode": true,      // 微信模式开关
  "robotName": "ClaudeCode", // 机器人名称
  "ccId": "my-project",    // CC 唯一标识
  "autoApprove": true,     // 自动审批开关（Hook 检查此字段）
  "autoApproveTimeout": 600  // 自动审批超时（秒）
}
```

---

## 进入流程（用户触发）

### 1. 检查项目配置文件（必须首先执行）

**检查文件**：`项目目录/.claude/wecom-aibot.json`

```
如果文件存在：
  - 读取 ccId 和 robotName
  - 直接调用 enter_headless_mode(cc_id=ccId, robot_id=robotName)
  - 无需重新生成 ccId

如果文件不存在：
  - 需要生成 ccId 并注册
  - 继续执行步骤 2
```

### 2. 生成 ccId（配置文件不存在时）

**ccId 生成规则**：
1. 使用项目目录名作为基础（如 `wecom-aibot-mcp`、`ModuleStudio`）
2. 如果项目名称不够辨识，可追加特征（如 `ModuleStudio-backend`）
3. **必须通过 AskUserQuestion 让用户确认**

```
AskUserQuestion:
    question: "请确认微信模式的身份标识（用于多项目区分）"
    options: 
      - "使用项目名: <项目目录名>" (Recommended)
      - "自定义名称..."
```

**多 CC 场景重要性**：
- 用户可能同时运行多个 Claude Code 项目
- ccId 用于在微信消息中区分不同项目（格式：`【ccId】消息内容`）
- 用户引用回复时需包含 ccId（如 `【wecom-aibot-mcp】好的`）

### 3. 选择机器人（配置文件无 robotName 时）

```
mcp__wecom-aibot__list_robots()

如果机器人数量 = 1 → 直接使用
如果机器人数量 > 1 → AskUserQuestion 让用户选择
```

### 4. 调用 enter_headless_mode

```
mcp__wecom-aibot__enter_headless_mode(
  cc_id="<已注册的ccId>",
  robot_id="<机器人名称>",
  project_dir="<项目目录>"
)
```

**参数说明**：
- `cc_id`: **必填**，已注册的 CCID
- `robot_id`: **必填**（多机器人场景）
- `project_dir`: **必填**，用于写入配置文件

**返回值**：
- `entered` → 进入成功，开始轮询
- `select_robot` → 需要选择机器人（未传 robot_id）

**注意**：
- MCP 自动写入 `.claude/wecom-aibot.json`，设置 `wechatMode: true`、`ccId`、`robotName`

### 5. 发确认消息

```
mcp__wecom-aibot__send_message(cc_id="<ccId>", content="【进度】已进入微信模式")
```

### 6. 开始长轮询

```
while (true):
  result = mcp__wecom-aibot__get_pending_messages(cc_id="<ccId>", timeout_ms=30000)
  if result.messages → 处理消息
  if result.timeout → 立即重新调用（不等待，不需要 sleep）
```

**重要**：`timeout: true` 不是停止信号！
- 长轮询超时只表示"这 30 秒内没有消息"
- 必须立即重新调用 `get_pending_messages`
- 返回值包含 `hint: "超时不是停止信号，必须立即重新调用..."`

---

## 启动时自动恢复

**检查文件**：`项目目录/.claude/wecom-aibot.json`

如果文件存在且 `wechatMode: true`：

```
1. 读取 ccId 和 robotName
2. 调用 enter_headless_mode(cc_id=ccId, robot_id=robotName)
3. 发送：【进度】已自动恢复微信模式
4. 开始轮询
```

---

## 处理用户消息

1. **收到指令后先应答**：立即发送简短确认（如「收到，开始处理...」）
2. 理解意图
3. 执行操作（Bash/Edit/Write 等）
4. 用 `send_message(cc_id="<ccId>", content="结果")` 汇报
5. 继续轮询

---

## 任务完成后的行为

### Hook 自动处理

当任务完成时，`TaskCompleted Hook` 自动检查配置文件：

**如果 Hook 返回 exit 2**（需要恢复轮询）：
```
Hook 输出: "任务已完成，请调用 mcp__wecom-aibot__get_pending_messages(cc_id=<ccId>, timeout_ms=30000) 恢复微信消息轮询"

智能体必须执行:
1. send_message(cc_id="<ccId>", content="【完成】任务结果...")
2. get_pending_messages(cc_id="<ccId>", timeout_ms=30000) → 恢复轮询
```

### 为什么需要 Hook

- **用户期望**：`autoApprove: true` 表示用户希望通过微信接收结果
- **防止遗忘**：智能体可能在任务完成后忘记恢复轮询
- **自动提醒**：Hook 阻止完成并提示智能体恢复轮询

---

## 退出流程

**触发词**：「结束微信模式」「我回来了」

```
mcp__wecom-aibot__exit_headless_mode(cc_id="<ccId>", project_dir="<项目目录>")
```

MCP 自动更新 `wechatMode: false`，停止轮询。

---

## 消息格式

**正确格式**：`【标签】消息内容`

| 标签 | 用途 |
|------|------|
| `【进度】` | 里程碑汇报、收到指令确认 |
| `【完成】` | 任务完成 |
| `【问题】` | 需用户决策 |
| `【需要确认】` | 二次确认 |