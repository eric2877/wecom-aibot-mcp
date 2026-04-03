# @various/wecom-aibot-mcp

企业微信智能机器人 MCP 服务 - Claude Code 审批通道

> 本服务通过企业微信智能机器人 API 实现 Claude Code 的远程审批和消息推送能力，让你离开电脑时也能处理 Claude 的决策请求。

## 配置架构

### 配置文件层级

Claude Code 使用多层级配置体系：

| 文件 | 路径 | 用途 |
|------|------|------|
| 全局配置 | `~/.claude.json` | MCP Servers 定义、账户信息、功能开关 |
| 全局权限 | `~/.claude/settings.local.json` | 全局权限预授权、Hooks 配置 |
| 项目权限 | `.claude/settings.local.json` | 项目级权限覆盖（优先级更高） |

**优先级**：项目权限 > 全局权限 > 默认行为

### ~/.claude.json 结构详解

```json
{
  "mcpServers": {
    "wecom-aibot": {
      "command": "node",
      "args": ["dist/bin.js"],
      "env": {
        "WECOM_BOT_ID": "机器人ID",
        "WECOM_SECRET": "机器人密钥",
        "WECOM_TARGET_USER": "目标用户ID"
      }
    }
  }
}
```

**字段说明**：
- `command`: MCP 服务启动命令（`node` / `npx` / 直接可执行文件）
- `args`: 命令参数
- `env`: 环境变量（敏感信息如 Secret 应通过环境变量传递）
- `type`: 连接类型，默认 `stdio`，HTTP 服务使用 `http`
- `url`: HTTP MCP 服务的 endpoint（type=http 时必填）

### settings.local.json 结构详解

```json
{
  "permissions": {
    "allow": [
      "mcp__wecom-aibot__send_message",
      "mcp__wecom-aibot__send_approval_request",
      "mcp__wecom-aibot__get_approval_result",
      "mcp__wecom-aibot__check_connection",
      "mcp__wecom-aibot__get_pending_messages",
      "mcp__wecom-aibot__get_setup_guide",
      "mcp__wecom-aibot__add_robot_config"
    ]
  },
  "hooks": {
    "PermissionRequest": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "/path/to/permission-hook.sh"
          }
        ]
      }
    ]
  }
}
```

**permissions.allow**：预授权的工具列表，调用时无需弹出确认对话框。

**hooks.PermissionRequest**：权限请求拦截器配置：
- `matcher`: 匹配规则（空字符串匹配所有）
- `hooks[].type`: hook 类型，目前支持 `command`
- `hooks[].command`: hook 脚本路径

### 为什么需要预授权？

1. **Headless 模式**：离开电脑时，无法点击终端确认框
2. **工作流阻断**：如果 MCP 工具需要确认，审批流程会卡住
3. **自动化体验**：预授权实现无缝的微信审批体验

> ⚠️ 预授权仅针对 MCP 工具本身。Write、Bash 等敏感操作仍需审批。

---

## Hooks 工作原理

### PermissionRequest Hook 流程

```
Claude 请求执行工具
       ↓
Hook 脚本拦截请求
       ↓
判断工具类型：
  ├─ MCP 工具 → 直接允许（已预授权）
  ├─ 只读工具 → 直接允许
  └─ 其他工具 → 转发到审批服务
       ↓
审批服务发送微信卡片
       ↓
用户在微信点击按钮
       ↓
审批结果返回 Hook
       ↓
Claude 执行或拒绝操作
```

### Hook 脚本逻辑（permission-hook.sh）

```bash
# 1. MCP 工具直接允许
if [[ "$TOOL_NAME" == mcp__* ]]; then
  echo '{"decision":{"behavior":"allow"}}'
  exit 0
fi

# 2. 只读工具直接允许
case "$TOOL_NAME" in
  Read|Glob|Grep|...) 
    echo '{"decision":{"behavior":"allow"}}'
    exit 0
    ;;
esac

# 3. 检查审批服务状态
curl -s "http://127.0.0.1:18963/health"

# 4. 转发审批请求到微信
curl -X POST "http://127.0.0.1:18963/approve"

# 5. 根据用户响应决定行为
case "$DECISION" in
  allow) ...
  deny) ...
esac
```

### 自动允许的工具清单

| 类别 | 工具 |
|------|------|
| 只读 | Read, Glob, Grep, LS, TaskList, TaskGet, TaskOutput, CronList |
| 交互 | AskUserQuestion, Skill, ListMcpResourcesTool |
| 规划 | EnterPlanMode, ExitPlanMode |
| 搜索 | WebSearch, ToolSearch |

---

## 快速开始

```bash
# 安装运行
npx @various/wecom-aibot-mcp

# 查看帮助
npx @various/wecom-aibot-mcp --help

# 查看版本
npx @various/wecom-aibot-mcp --version

# 查看当前配置
npx @various/wecom-aibot-mcp --status

# 重新配置
npx @various/wecom-aibot-mcp --config
```

## 在 Claude Code 中配置

### 步骤 1：添加 MCP 服务

编辑 `~/.claude.json`，在 `mcpServers` 中添加：

```json
{
  "mcpServers": {
    "wecom-aibot": {
      "command": "npx",
      "args": ["@various/wecom-aibot-mcp"],
      "env": {
        "WECOM_BOT_ID": "your_bot_id",
        "WECOM_SECRET": "your_secret",
        "WECOM_TARGET_USER": "your_userid"
      }
    }
  }
}
```

### 步骤 2：自动权限预授权

**首次运行配置向导时，会自动写入权限配置，无需手动配置！**

配置向导会在保存配置时自动将以下权限添加到 `~/.claude/settings.local.json`：

```json
{
  "permissions": {
    "allow": [
      "mcp__wecom-aibot__send_message",
      "mcp__wecom-aibot__send_approval_request",
      "mcp__wecom-aibot__get_approval_result",
      "mcp__wecom-aibot__check_connection",
      "mcp__wecom-aibot__get_pending_messages",
      "mcp__wecom-aibot__get_setup_guide",
      "mcp__wecom-aibot__add_robot_config"
    ]
  }
}
```

**为什么必须预授权？**
- 如果不预授权，调用工具时会弹出确认对话框
- headless 模式下你不在电脑前，无法点击确认
- 工作流会被阻断，任务无法完成

> ⚠️ 如果权限写入失败，请手动添加上述配置到 `~/.claude/settings.local.json`

## 多用户/多机器人配置

每个用户可以使用独立的机器人，只需配置不同的环境变量：

```json
{
  "mcpServers": {
    "wecom-aibot-zhangsan": {
      "command": "npx",
      "args": ["@various/wecom-aibot-mcp"],
      "env": {
        "WECOM_BOT_ID": "bot_zhangsan",
        "WECOM_SECRET": "secret_zhangsan",
        "WECOM_TARGET_USER": "zhangsan"
      }
    },
    "wecom-aibot-lisi": {
      "command": "npx",
      "args": ["@various/wecom-aibot-mcp"],
      "env": {
        "WECOM_BOT_ID": "bot_lisi",
        "WECOM_SECRET": "secret_lisi",
        "WECOM_TARGET_USER": "lisi"
      }
    }
  }
}
```

## 配置优先级

1. **环境变量**（最高优先级）：
   - `WECOM_BOT_ID` - 机器人 ID
   - `WECOM_SECRET` - 机器人密钥
   - `WECOM_TARGET_USER` - 默认目标用户

2. **配置文件**：`~/.wecom-aibot-mcp/config.json`

3. **配置向导**：首次运行时自动启动

## MCP 工具

### send_message
发送消息到企业微信

```
参数:
- content: 消息内容（支持 Markdown）
- target_user: 目标用户 ID（可选）
```

### send_approval_request
发送审批请求（带按钮卡片）

```
参数:
- title: 审批标题
- description: 审批描述
- request_id: 请求 ID
- target_user: 目标用户 ID（可选）
```

审批卡片包含三个按钮：允许一次、永久允许、拒绝

### get_approval_result
获取审批结果（阻塞等待，永不过期）

```
参数:
- task_id: 审批任务 ID

返回: allow-once / allow-always / deny
```

### get_pending_messages
获取用户主动发送的消息（非阻塞）

```
参数:
- clear: 获取后是否清空队列（默认 true）

建议轮询间隔: 5 秒
```

### check_connection
检查连接状态和默认目标用户

### get_setup_guide
获取安装配置指南（首次安装必读）

### add_robot_config
生成新机器人 MCP 配置片段（用于添加更多用户/机器人）

```
参数:
- instance_name: MCP 实例名称（如 wecom-aibot-zhangsan）
- bot_id: 企业微信机器人 ID
- secret: 机器人密钥
- target_user: 默认目标用户 ID
```

## 获取凭证

1. 登录企业微信管理后台：work.weixin.qq.com
2. 进入「管理工具」→「智能机器人」
3. 点击「创建机器人」→「手动创建」
4. 在「API 配置」中选择「使用长连接」
5. 获取 **Bot ID** 和 **Secret**

> ⚠️ 每个机器人同时只能保持一个有效长连接

## 使用示例

### 场景 1：发送通知

```
用户：通知我任务已完成
AI：调用 send_message(content="任务已完成")
```

### 场景 2：请求审批

```
用户：删除这个文件
AI：调用 send_approval_request(title="删除文件", description="即将删除 /tmp/test.log", request_id="del-001")
AI：调用 get_approval_result(task_id)
AI：根据结果执行或取消操作
```

### 场景 3：添加新用户

```
用户：帮我添加一个新机器人，Bot ID 是 xxx，Secret 是 xxx，给用户 zhangsan 用
AI：调用 add_robot_config(instance_name="wecom-aibot-zhangsan", bot_id="xxx", secret="xxx", target_user="zhangsan")
AI：返回配置片段，用户添加到 ~/.claude.json
```

## 故障排查

### 无法收到消息
- 确认机器人已添加到通讯录
- 确认进入了正确的机器人会话
- 群聊需要 @机器人 才能触发

### 连接失败
- 检查 Bot ID 和 Secret 是否正确
- 确认网络可以访问 `wss://openws.work.weixin.qq.com`
- 确认没有其他客户端同时连接同一个机器人

## License

MIT