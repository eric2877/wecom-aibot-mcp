# @vrs-soft/wecom-aibot-mcp

企业微信智能机器人 MCP 服务 - Claude Code 远程审批通道

> 通过企业微信智能机器人实现 Claude Code 的远程审批和消息推送，离开电脑也能处理决策请求。

## 功能特性

- 🔐 **远程审批**：敏感操作通过微信卡片审批，支持"允许一次/永久允许/拒绝"
- 💬 **消息推送**：任务进度、完成通知实时推送到微信
- 📱 **Headless 模式**：离开电脑时切换到微信交互
- 🔄 **多实例支持**：多个 Claude Code 可同时运行，自动分配端口
- 🧹 **自动清理**：进程退出后自动清理残留文件

## 架构

```
┌─────────────────┐      MCP (stdio)      ┌──────────────────┐
│  Claude Code    │  ──────────────────▶  │  wecom-aibot-mcp │
│  (MCP Client)   │                       │  MCP Server      │
└─────────────────┘                       └──────────────────┘
                                                   │
                                           WebSocket 长连接
                                                   ↓
                                          ┌───────────────────┐
                                          │  企业微信服务器     │
                                          │  wss://openws...   │
                                          └───────────────────┘
                                                   │
                                                   ↓
                                          ┌───────────────────┐
                                          │  用户企业微信客户端  │
                                          │  (手机/桌面)        │
                                          └───────────────────┘
```

### 审批流程

```
Claude 请求执行敏感操作（Bash/Write/Edit 等）
              ↓
PermissionRequest Hook 拦截
              ↓
     ┌────────────────────────┐
     │ 检查 headless 模式状态  │
     └────────────────────────┘
              │
      ┌───────┴───────┐
      ↓               ↓
  非 headless      headless
      ↓               ↓
 终端确认框      发送微信审批卡片
      │               │
      │         用户点击按钮
      │               │
      └───────┬───────┘
              ↓
      执行或拒绝操作
```

## 安装

### 前置要求

- Node.js >= 18
- 企业微信账号（有创建机器人权限）
- Claude Code 已安装

### 方式一：npx 直接运行（推荐）

```bash
npx @vrs-soft/wecom-aibot-mcp
```

### 方式二：全局安装

```bash
npm install -g @vrs-soft/wecom-aibot-mcp
wecom-aibot-mcp
```

### 方式三：从源码安装

```bash
git clone https://github.com/eric2877/wecom-aibot-mcp.git
cd wecom-aibot-mcp
npm install
npm run build
npm link
```

## 快速开始

### 第一步：创建企业微信机器人

1. 登录企业微信管理后台：https://work.weixin.qq.com
2. 进入「管理工具」→「智能机器人」
3. 点击「创建机器人」→「手动创建」
4. 填写机器人名称（如"Claude 审批助手"）
5. 在「API 配置」区域：
   - 连接方式选择「**使用长连接**」
   - 点击「获取 Secret」
6. 记录以下信息：
   - **Bot ID**：机器人唯一标识
   - **Secret**：长连接密钥

> ⚠️ 每个机器人同时只能保持一个 WebSocket 长连接

### 第二步：获取目标用户 ID

目标用户 ID 是审批消息发送给谁。获取方式：

1. 在企业微信通讯录中找到目标用户
2. 查看用户详情，**账号**字段即为 User ID
3. 例如：`zhangsan`、`lisi`

### 第三步：配置 Claude Code

编辑 `~/.claude.json`（不存在则创建）：

```json
{
  "mcpServers": {
    "wecom-aibot": {
      "command": "npx",
      "args": ["@vrs-soft/wecom-aibot-mcp"],
      "env": {
        "WECOM_BOT_ID": "你的Bot ID",
        "WECOM_SECRET": "你的Secret",
        "WECOM_TARGET_USER": "目标用户ID"
      }
    }
  }
}
```

### 第四步：重启 Claude Code

1. 运行 `/mcp` 命令
2. 选择「Reconnect」重新连接 MCP 服务
3. 首次连接时会自动：
   - 检查配置完整性
   - 注册权限预授权
   - 生成审批 Hook 脚本

### 第五步：验证连接

```
你：检查微信连接状态
Claude：（调用 check_connection）
返回：{"connected":true,"defaultTargetUser":"zhangsan"}
```

## 使用示例

### 场景 1：发送任务完成通知

```
你：帮我重构这个函数，完成后微信通知我

Claude：[执行重构操作...]

Claude：（调用 send_message）
微信收到：
┌─────────────────────────┐
│ 【完成】函数重构完成      │
│                         │
│ 已将 parseData 函数拆分  │
│ 为 3 个独立函数，提高可读性│
└─────────────────────────┘
```

### 场景 2：远程审批（Headless 模式）

```
你：我要离开电脑前了，现在开始通过微信联系

Claude：（调用 enter_headless_mode）
微信收到：【进度】已进入微信模式，所有交互将通过企业微信进行。

[你离开电脑，Claude 需要执行删除文件操作]

微信收到审批卡片：
┌─────────────────────────┐
│ 【待审批】Bash           │
│                         │
│ 执行命令: rm -rf dist    │
│                         │
│ [允许一次] [永久允许] [拒绝]│
└─────────────────────────┘

[你在手机点击"允许一次"]

Claude 继续执行...

你：我回来了

Claude：（调用 exit_headless_mode）
微信收到：【进度】已退出微信模式，恢复终端交互。
```

### 场景 3：群聊机器人

将机器人拉入群聊，@机器人 即可触发：

```
群聊中：
张三：@Claude助手 帮我查看服务器日志

Claude：（执行命令，通过 send_message 发送结果到群聊）
微信收到：
┌─────────────────────────┐
│ 📋 服务器日志摘要         │
│                         │
│ 最近 10 条错误日志...    │
└─────────────────────────┘
```

### 场景 4：长时间任务监控

```
你：帮我跑一遍测试套件，有失败的通知我

Claude：（调用 send_message）
微信收到：【进度】开始运行测试套件，共 128 个用例...

[测试运行中...]

Claude：（调用 send_message）
微信收到：
┌─────────────────────────┐
│ ⚠️ 测试失败              │
│                         │
│ 失败用例：test/auth.spec.ts│
│ 原因：登录超时            │
│                         │
│ 总计：125 通过，3 失败    │
└─────────────────────────┘
```

### 场景 5：定时任务提醒

结合 Cron 工具实现定时提醒：

```
你：每天早上 9 点提醒我开站会

Claude：（设置定时任务）

每天 9:00 微信收到：
┌─────────────────────────┐
│ ⏰ 每日提醒              │
│                         │
│ 该开站会了！             │
└─────────────────────────┘
```

## MCP 工具

### 消息类

| 工具 | 说明 | 参数 |
|------|------|------|
| `send_message` | 发送消息到微信 | `content`(内容), `target_user`(可选) |
| `get_pending_messages` | 获取用户消息 | `clear`(是否清空队列) |

### 审批类

| 工具 | 说明 | 参数 |
|------|------|------|
| `send_approval_request` | 发送审批卡片 | `title`, `description`, `request_id` |
| `get_approval_result` | 获取审批结果 | `task_id` |

### 模式控制

| 工具 | 说明 |
|------|------|
| `enter_headless_mode` | 进入微信审批模式 |
| `exit_headless_mode` | 退出微信审批模式 |
| `check_connection` | 检查连接状态 |

### 辅助类

| 工具 | 说明 |
|------|------|
| `get_setup_guide` | 获取安装指南 |
| `add_robot_config` | 生成新机器人配置片段 |

## 多用户配置

### 场景：团队共享

每个开发者使用独立的机器人：

```json
{
  "mcpServers": {
    "wecom-aibot-zhangsan": {
      "command": "npx",
      "args": ["@vrs-soft/wecom-aibot-mcp"],
      "env": {
        "WECOM_BOT_ID": "bot_zhangsan",
        "WECOM_SECRET": "secret_zhangsan",
        "WECOM_TARGET_USER": "zhangsan"
      }
    },
    "wecom-aibot-lisi": {
      "command": "npx",
      "args": ["@vrs-soft/wecom-aibot-mcp"],
      "env": {
        "WECOM_BOT_ID": "bot_lisi",
        "WECOM_SECRET": "secret_lisi",
        "WECOM_TARGET_USER": "lisi"
      }
    }
  }
}
```

### 多实例端口分配

当多个 Claude Code 实例同时运行时，HTTP 服务端口自动递增：

- 实例 1：端口 18963
- 实例 2：端口 18964
- 实例 3：端口 18965
- ...

端口文件存储在 `~/.wecom-aibot-mcp/port-{PID}`，进程退出后自动清理。

## 环境变量

| 变量 | 说明 | 必填 | 示例 |
|------|------|------|------|
| `WECOM_BOT_ID` | 机器人 ID | ✅ | `bot_abc123` |
| `WECOM_SECRET` | 机器人密钥 | ✅ | `xyz789...` |
| `WECOM_TARGET_USER` | 默认目标用户 | ✅ | `zhangsan` |

## 故障排查

### 无法收到消息

**可能原因**：
- 机器人未添加到通讯录
- 群聊中未 @机器人
- WebSocket 连接断开

**解决方法**：
```
1. 在企业微信中搜索机器人名称，添加到通讯录
2. 群聊中必须 @机器人 才能触发消息
3. 运行 check_connection 检查连接状态
```

### 连接失败

**检查项**：
```bash
# 1. 检查网络连通性
curl -v wss://openws.work.weixin.qq.com

# 2. 确认凭证正确
cat ~/.wecom-aibot-mcp/config.json

# 3. 查看进程日志
# 重启 Claude Code，观察启动日志
```

### 审批没发到微信

**检查 headless 状态**：
```bash
# 查看状态文件
ls ~/.wecom-aibot-mcp/headless-*

# 如果没有文件，说明不在 headless 模式
# 需要告诉 Claude：「现在开始通过微信联系」
```

### 端口文件残留

```bash
# 查看残留文件
ls ~/.wecom-aibot-mcp/port-*

# 重启 MCP 服务会自动清理孤儿文件
# 或手动清理
rm ~/.wecom-aibot-mcp/port-*
```

## 安全建议

1. **保护凭证**：Bot ID 和 Secret 不要提交到代码仓库
2. **使用环境变量**：通过 `env` 传递敏感信息，而不是硬编码
3. **定期轮换**：建议每 3 个月更换一次 Secret
4. **权限最小化**：机器人的可见范围设置为需要的用户/部门即可

## 开发

```bash
# 克隆仓库
git clone https://github.com/eric2877/wecom-aibot-mcp.git
cd wecom-aibot-mcp

# 安装依赖
npm install

# 开发模式（自动重新编译）
npm run dev

# 构建
npm run build

# 运行
npm start
```

## License

MIT

## 相关链接

- [企业微信智能机器人文档](https://developer.work.weixin.qq.com/document/path/101039)
- [Claude Code 文档](https://docs.anthropic.com/claude-code)
- [MCP 协议规范](https://modelcontextprotocol.io)