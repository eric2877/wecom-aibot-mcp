---
name: headless-mode
description: 当用户说「现在开始通过微信联系」时触发，进入微信交互模式
---

# Headless 微信交互模式

## 触发

用户说：「现在开始通过微信联系」、「我要离开电脑前」、「切换到微信模式」

## 流程

**Step 1**：调用 `enter_headless_mode(agent_name, project_dir)`
- 如果返回 `select_robot`：展示列表，等待用户选择，再次调用带 robot_id 参数
- 如果返回 `error: robot_occupied`：提示用户选择其他机器人
- 如果返回 `entered`：继续 Step 2

**重要**：`enter_headless_mode` 会自动在项目目录 `{项目}/.claude/settings.json` 中配置 PermissionRequest hook。无需手动配置。

**Step 2**：发送确认消息：`【进度】已进入微信模式，所有交互将通过企业微信进行。`

**Step 3**：**持续轮询** - 必须真正执行，不是打印文字

```
初始化：
  interval = 10  // 基础间隔（秒）
  emptyCount = 0  // 连续空轮询计数

循环执行：
  调用 get_pending_messages(clear=true)
  
  如果有消息：
    emptyCount = 0  // 重置计数
    interval = 10   // 重置间隔
    1. 处理消息（执行任务、回复等）
    2. send_message 汇报结果
    3. 继续循环
  
  如果无消息：
    emptyCount += 1
    if emptyCount % 12 == 0:
      interval = min(interval + 12, 46)  // 每次增加12秒，最大46秒
    等待 interval 秒
    继续循环
  
  永不退出，除非收到结束指令
```

## 处理用户消息

| 消息类型 | 示例 | 动作 |
|---------|------|------|
| 任务请求 | "帮我写个脚本" | 执行工具 → send_message 汇报结果 → 继续轮询 |
| 智能审批 | "启用智能审批" | set_auto_approve(true) → send_message 确认 → 继续轮询 |
| 智能审批 | "关闭智能审批" | set_auto_approve(false) → send_message 确认 → 继续轮询 |
| 结束模式 | "结束微信模式"、"我回来了" | exit_headless_mode → 停止轮询 |

## 结束模式

调用 `exit_headless_mode` 时会：
1. 删除 headless 状态文件
2. **自动删除**项目目录 `{项目}/.claude/settings.json` 中的 PermissionRequest hook 配置
3. 发送退出通知

无需手动清理 hook 配置。

## 轮询间隔策略

基础间隔：**10 秒**

| 连续空轮询次数 | 间隔 | 说明 |
|---------------|------|------|
| 0-12 次 | 10 秒 | 正常模式 |
| 13-24 次 | 22 秒 | 用户可能短暂离开 |
| 25-36 次 | 34 秒 | 用户可能在休息 |
| 37+ 次 | 46 秒（最大） | 省电模式 |

**规则**：
- 每连续 12 次空轮询，间隔增加 12 秒
- 收到新消息后立即重置为 10 秒间隔

## 审批处理

进入微信模式后，执行敏感操作（Bash、Write、Edit等）时：
1. 自动发送审批卡片到微信
2. **阻塞等待**用户审批
3. 审批结束后**立即恢复轮询**

无需手动调用 send_approval_request。

## 错误处理

| 返回状态 | 说明 | 动作 |
|---------|------|------|
| `select_robot` | 多机器人需选择 | 展示列表，等待用户回复序号或名称 |
| `error: robot_occupied` | 机器人已被占用 | 提示选择其他机器人或等待释放 |
| `error: 未配置机器人` | 无机器人配置 | 提示运行 `npx @vrs-soft/wecom-aibot-mcp --config` |

## 群聊消息

get_pending_messages 返回 `chattype` 和 `chatid`：
- 单聊：chatid = 用户ID
- 群聊：chatid = 群ID

群聊回复时：`send_message(content, target_user=chatid)`

## 消息格式

| 标签 | 用途 |
|------|------|
| `【需要确认】` | 需要用户决策 |
| `【问题】` | 阻塞性问题 |
| `【进度】` | 里程碑汇报 |
| `【完成】` | 任务完成，继续轮询 |

## Hook 配置说明

### 自动配置

`enter_headless_mode` 会自动在项目目录配置 hook：

**文件位置**：`{项目}/.claude/settings.json`

```json
{
  "hooks": {
    "PermissionRequest": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "/Users/eric/.wecom-aibot-mcp/permission-hook.sh",
            "timeout": 600
          }
        ]
      }
    ]
  }
}
```

### 自动清理

`exit_headless_mode` 会自动删除 hook 配置，恢复 settings.json 到原始状态。

## 核心规则

1. **轮询永不退出**（除非收到明确结束指令）
2. **持续调用 get_pending_messages**，不是打印"轮询中"
3. **只有审批时阻塞**，审批后立即恢复轮询
4. 处理完消息后**立即继续轮询**，不要停止
5. **Hook 配置自动管理**，进入时添加，退出时删除