# @vrs-soft/wecom-aibot-mcp

企业微信智能机器人 MCP 服务 - Claude Code 远程审批通道

> 通过企业微信智能机器人实现 Claude Code 的远程审批和消息推送，离开电脑也能处理决策请求。

## 功能特性

- 🔐 **远程审批**：敏感操作通过微信卡片审批，支持"允许一次/永久允许/拒绝"
- 💬 **消息推送**：任务进度、完成通知实时推送到微信
- 📱 **Headless 模式**：离开电脑时切换到微信交互
- 🔄 **智能代批**：超时自动审批，项目内操作允许，删除操作拒绝
- 🔄 **多机器人支持**：支持配置多个机器人，适用于团队场景

## 架构

```
┌─────────────────┐      MCP (HTTP)       ┌──────────────────┐
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

### 智能代批

开启「自动审批」后，审批请求超时（10分钟）会自动决策：

| 操作类型 | 条件 | 自动决策 |
|---------|------|---------|
| Bash | 包含 rm/rmdir/unlink | ❌ 拒绝 |
| Bash | 项目内操作或常见命令 | ✅ 允许 |
| Bash | 无法判断范围 | ❌ 拒绝 |
| Write/Edit | 项目内文件 | ✅ 允许 |
| Write/Edit | 项目外文件 | ❌ 拒绝 |

## 安装

### 前置要求

- **Node.js >= 18**（必需）
- 企业微信账号（有创建机器人权限）
- Claude Code 已安装

### 安装 Node.js

**检查版本**：
```bash
node --version
# 输出应 >= v18.0.0
```

**安装方式**：

**macOS**：
```bash
# 使用 Homebrew
brew install node

# 或使用 nvm（推荐，可管理多版本）
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash
nvm install 18
nvm use 18
```

**Windows**：
```bash
# 使用 winget
winget install OpenJS.NodeJS.LTS

# 或下载安装包：https://nodejs.org/
```

**Linux**：
```bash
# Ubuntu/Debian
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# 或使用 nvm
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash
nvm install 18
nvm use 18
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

### 第二步：运行配置向导

```bash
npx @vrs-soft/wecom-aibot-mcp
```

配置向导会引导您完成以下步骤：

1. **输入 Bot ID** - 从企业微信管理后台复制
2. **输入 Secret** - 从企业微信管理后台复制
3. **发送消息识别用户** - 让需要接收审批消息的人，在企业微信中给机器人发送一条消息，系统会自动识别其用户 ID

> ✅ 无需手动查找用户 ID，系统会自动识别并回复确认消息

### 常用命令

| 命令 | 说明 |
|------|------|
| `npx @vrs-soft/wecom-aibot-mcp` | 首次配置向导 |
| `npx @vrs-soft/wecom-aibot-mcp --config` | 修改现有配置 |
| `npx @vrs-soft/wecom-aibot-mcp --add` | 添加新机器人 |
| `npx @vrs-soft/wecom-aibot-mcp --delete` | 删除机器人配置 |
| `npx @vrs-soft/wecom-aibot-mcp --uninstall` | 完全卸载 |
| `npx @vrs-soft/wecom-aibot-mcp --server` | 启动 HTTP 服务模式 |
| `npx @vrs-soft/wecom-aibot-mcp --status` | 查看当前状态 |

### 添加新机器人（--add）

适用于多用户场景，每个用户使用独立机器人：

```bash
npx @vrs-soft/wecom-aibot-mcp --add
```

交互流程：
1. 输入机器人名称（如"张三的审批助手"）
2. 输入 Bot ID
3. 输入 Secret
4. 发送消息识别用户 ID
5. 选择添加到 MCP 配置的位置

### 删除机器人配置（--delete）

```bash
npx @vrs-soft/wecom-aibot-mcp --delete
```

交互流程：
1. 显示已配置的机器人列表
2. 选择要删除的机器人
3. 确认删除

也可以直接指定机器人名称：
```bash
npx @vrs-soft/wecom-aibot-mcp --delete "张三的审批助手"
```

### 完全卸载（--uninstall）

删除所有配置和文件：

```bash
npx @vrs-soft/wecom-aibot-mcp --uninstall
```

这会删除：
- 配置目录：`~/.wecom-aibot-mcp/`
- MCP 配置：`~/.claude.json` 中的所有 `wecom-aibot-*` 条目
- 全局 Hook 配置：`~/.claude/settings.local.json` 中的 PermissionRequest hook
- Skill 文件：`~/.claude/skills/headless-mode/`

卸载后如需重新安装：
```bash
npx @vrs-soft/wecom-aibot-mcp --config
```

### 第三步：配置 Claude Code

编辑 `~/.claude.json`（不存在则创建）：

```json
{
  "mcpServers": {
    "wecom-aibot": {
      "type": "http",
      "url": "http://127.0.0.1:18963/mcp"
    }
  }
}
```

> 使用 HTTP Transport，无需在配置中传递环境变量，配置向导会自动管理。

### 第四步：启动 MCP 服务

```bash
npx @vrs-soft/wecom-aibot-mcp --server
```

服务启动后会显示：
```
╔════════════════════════════════════════════════════════╗
║   企业微信智能机器人 MCP 服务 v1.0.6                   ║
║   Claude Code 审批通道                                 ║
╚════════════════════════════════════════════════════════╝

[mcp] MCP Server 已启动: http://127.0.0.1:18963
[mcp] MCP endpoint: http://127.0.0.1:18963/mcp
[mcp] 健康检查: http://127.0.0.1:18963/health
```

### 第五步：重启 Claude Code

1. 运行 `/mcp` 命令
2. 选择「Reconnect」重新连接 MCP 服务

### 第六步：验证连接

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

### 场景 3：开启智能代批

```
你：开启自动审批

Claude：（调用 set_auto_approve）
微信收到：【系统】自动审批已开启，超时 10 分钟后将自动处理审批请求。

[你离开电脑去开会，超过 10 分钟未响应]

Claude：（自动审批，项目内操作允许）
微信收到：
┌─────────────────────────┐
│ 【自动审批简报】         │
│                         │
│ 由于您长时间未响应，系统 │
│ 已代为处理：             │
│                         │
│ ✅ npm run build        │
│ ✅ 修改 src/index.ts    │
│ ❌ rm -rf dist (删除操作)│
└─────────────────────────┘
```

### 场景 4：群聊机器人

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
| `set_auto_approve` | 设置自动审批开关 | `enabled`(布尔值) |

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
| `list_robots` | 列出所有机器人及状态 |
| `get_robot_status` | 查看机器人详细状态 |

## 多机器人配置

### 场景：团队共享

使用 `--add` 命令添加多个机器人：

```bash
# 添加张三的机器人
npx @vrs-soft/wecom-aibot-mcp --add
# 输入名称：张三的审批助手
# 输入 Bot ID 和 Secret
# 发送消息识别用户

# 添加李四的机器人
npx @vrs-soft/wecom-aibot-mcp --add
# 输入名称：李四的审批助手
# ...
```

配置完成后，`~/.claude.json` 会包含多个实例：

```json
{
  "mcpServers": {
    "wecom-aibot-zhangsan": {
      "type": "http",
      "url": "http://127.0.0.1:18963/mcp"
    },
    "wecom-aibot-lisi": {
      "type": "http",
      "url": "http://127.0.0.1:18963/mcp"
    }
  }
}
```

### 查看机器人列表

```bash
npx @vrs-soft/wecom-aibot-mcp --status
```

或在 Claude Code 中：
```
你：列出所有机器人
Claude：（调用 list_robots）
返回：
{
  "robots": [
    {"projectDir": "...", "status": "connected", "defaultUser": "zhangsan"},
    {"projectDir": "...", "status": "connected", "defaultUser": "lisi"}
  ],
  "total": 2,
  "available": 2
}
```

## 故障排查

### 认证失败（错误码 40058）

**可能原因**：
- 机器人未授权
- Bot ID 或 Secret 配置错误
- 新建机器人需要等待同步时间

**解决方法**：
```
1. 新建机器人需要等待约 2 分钟同步时间，请稍后再试

2. 完成机器人授权（任选其一）：
   • 在电脑端企业微信APP中打开：机器人详情 → 可使用权限 → 授权
   • 打开浏览器访问授权页面，使用手机企业微信扫码：
     https://work.weixin.qq.com/ai/aiHelper/authorizationPage?str_aibotid={BotID}&type=6&from=chat&forceInnerBrowser=1

3. 确认 Bot ID 和 Secret 是否正确：
   npx @vrs-soft/wecom-aibot-mcp --status

4. 如需重新配置：
   npx @vrs-soft/wecom-aibot-mcp --config
```

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

# 2. 检查 HTTP 服务状态
curl http://127.0.0.1:18963/health

# 3. 查看进程日志
# 重启 MCP 服务，观察启动日志
```

### 审批没发到微信

**检查 headless 状态**：
```bash
# 查看状态文件
ls ~/.wecom-aibot-mcp/headless-*

# 如果没有文件，说明不在 headless 模式
# 需要告诉 Claude：「现在开始通过微信联系」
```

### 残留文件清理

```bash
# 查看残留文件
ls ~/.wecom-aibot-mcp/

# MCP 服务重启会自动清理孤儿文件
# 或使用卸载命令彻底清理
npx @vrs-soft/wecom-aibot-mcp --uninstall
```

## 安全建议

1. **保护凭证**：Bot ID 和 Secret 不要提交到代码仓库
2. **定期轮换**：建议每 3 个月更换一次 Secret
3. **权限最小化**：机器人的可见范围设置为需要的用户/部门即可
4. **谨慎使用自动审批**：仅在信任的环境下开启

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

# 运行服务
node dist/bin.js --server
```

## License

MIT

## 相关链接

- [企业微信智能机器人文档](https://developer.work.weixin.qq.com/document/path/101039)
- [Claude Code 文档](https://docs.anthropic.com/claude-code)
- [MCP 协议规范](https://modelcontextprotocol.io)