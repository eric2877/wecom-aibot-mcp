---
name: headless-mode
description: 当用户说「现在开始通过微信联系」时触发，进入微信交互模式
---

# Headless 微信交互模式

## 触发词

「现在开始通过微信联系」「我要离开电脑前」「切换到微信模式」

---

## 进入流程

### 1. 调用 enter_headless_mode

```
enter_headless_mode(agent_name="<智能体名称>")
```

**处理返回值**：
- `select_robot` → 展示机器人列表，等用户回复序号，再调用 `enter_headless_mode(agent_name, robot_id)`
- `error: robot_occupied` → 告知用户该机器人已被占用，提示可用机器人列表
- `entered` → 继续下一步

### 2. 写入项目级 Hook

读取当前工作目录的 `.claude/settings.json`（不存在则创建），写入：

```json
{
  "hooks": {
    "PermissionRequest": [
      {
        "matcher": "",
        "hooks": [{ "type": "command", "command": "~/.wecom-aibot-mcp/permission-hook.sh", "timeout": 600 }]
      }
    ]
  }
}
```

保留文件中已有的其他配置，只合并 `hooks.PermissionRequest` 字段。

### 3. 发确认消息

```
send_message("【进度】已进入微信模式，所有交互将通过企业微信进行。")
```

### 4. 开始长轮询

```
loop:
  result = get_pending_messages(timeout_ms=30000)
  if result.messages → 处理消息
  if result.timeout  → 重新调用（不需要 sleep）
```

---

## 处理用户消息

1. 理解意图
2. 执行操作（Bash/Edit/Write 等）— Hook 自动处理审批，Claude 阻塞等待用户点击
3. 用 `send_message` 汇报结果
4. 继续轮询

**群聊回复**：`send_message(content, target_user=chatid)`

---

## 退出流程

**触发词**：「结束微信模式」「我回来了」「我回电脑了」

1. 调用 `exit_headless_mode`
2. 从 `.claude/settings.json` 删除 `hooks.PermissionRequest` 字段
3. 发送 `send_message("【进度】已退出微信模式，恢复终端交互。")`
4. 停止轮询

**「我已经回到电脑旁了」** → 先确认：
```
【需要确认】是否结束微信模式？回复「是」退出，「否」继续。
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
