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

## 启动时自动恢复

**检查文件**：`项目目录/.claude/wecom-aibot.json`

如果该文件存在且 `autoApprove: true`，说明上次在微信模式下退出，应自动恢复：

```
1. 读取 wecom-aibot.json 获取 ccId 和 robotName
2. 自动进入微信模式（无需用户确认）
3. 发送消息：【进度】已自动恢复微信模式
4. 开始长轮询
```

---

## MCP 工具调用方式

**重要**：所有工具调用必须通过 `wecom-aibot` MCP 服务器：

| 功能 | MCP 工具名称 |
|------|-------------|
| 进入微信模式 | `mcp__wecom-aibot__enter_headless_mode` |
| 发送消息 | `mcp__wecom-aibot__send_message` |
| 获取消息（长轮询默认30秒间隔） | `mcp__wecom-aibot__get_pending_messages` |
| 退出微信模式 | `mcp__wecom-aibot__exit_headless_mode` |

---

## 进入流程

### 0. 读取配置文件（进入前必须执行）

检查项目目录下的 `.claude/wecom-aibot.json`：

- **文件存在** → 读取 `ccId` 和 `robotName`，用于后续调用
- **文件不存在** → 使用项目名称作为 ccId，进入时让用户选择机器人

**重要**：不要依赖记忆中的 ccId/robotName，必须从配置文件获取最新值。

### 1. 确定 ccId（如果配置文件中没有）

使用项目名称作为 ccId（从 package.json 或目录名获取）。

### 2. 调用 enter_headless_mode

```
mcp__wecom-aibot__enter_headless_mode(ccId="<项目名称>", projectDir="<项目目录>")
```

**参数说明**：
- `ccId`: CC 身份标识（建议使用项目名称）
- `projectDir`: 项目目录（用于写入 wecom-aibot.json，确保文件在正确位置）
- `robotName`: 可选，指定机器人名称或序号

**处理返回值**：
- `select_robot` → 展示机器人列表，等用户回复序号，再调用 `enter_headless_mode(ccId, robotName)`
- `error: robot_occupied` → 告知用户该机器人已被占用，提示可用机器人列表
- `entered` → 继续下一步

### 3. 写入项目级 Hook

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

1. 调用 `mcp__wecom-aibot__exit_headless_mode`
2. 从 `.claude/settings.json` 删除 `hooks.PermissionRequest` 字段
3. 更新 `wecom-aibot.json`，只修改 `autoApprove: false`（保留原有 ccId/robotName）
4. 发送 `mcp__wecom-aibot__send_message("【进度】已退出微信模式，恢复终端交互。")`
5. 停止轮询

**「我已经回到电脑旁了」** → 先确认：
```
mcp__wecom-aibot__send_message("【需要确认】是否结束微信模式？回复「是」退出，「否」继续。")
```

---

## 消息格式

| 标签 | 用途 |
|------|------|
| `【进度】` | 里程碑汇报 |
| `【完成】` | 任务完成，继续等待 |
| `【问题】` | 需用户决策 |
| `【需要确认】` | 二次确认 |

---

## 多 CC 消息路由

- **单 CC**：消息直接推送
- **多 CC**：用户需引用回复（引用内容含 `【cc-1】` 等标记路由）