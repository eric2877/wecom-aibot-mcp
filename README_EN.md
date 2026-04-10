# wecom-aibot-mcp

[中文文档](README.md) | English

Enterprise WeChat AI Bot MCP Service - Remote Approval Channel for Claude Code

> Handle Claude Code approval requests via WeChat, even when away from your computer.

## Features

- 🔐 **Remote Approval**: Approve/deny sensitive operations via WeChat cards
- 💬 **Bidirectional Communication**: Real-time task progress notifications
- 📱 **Headless Mode**: Switch to WeChat interaction when leaving terminal
- 🤖 **Multi-bot Support**: Multiple bots for team scenarios
- 🌐 **HTTP Transport**: HTTP-based MCP for shared service instances

## Architecture

```
┌─────────────────┐      MCP (HTTP)       ┌──────────────────┐
│  Claude Code    │  ──────────────────▶  │  wecom-aibot-mcp │
│  (MCP Client)   │  ◀──────────────────  │  MCP Server      │
└─────────────────┘                       └──────────────────┘
                                                   │
                                           WebSocket Connection
                                                   ↓
                                          ┌───────────────────┐
                                          │  Enterprise WeChat │
                                          │  Server            │
                                          └───────────────────┘
                                                   │
                                                   ↓
                                          ┌───────────────────┐
                                          │  User WeChat Client│
                                          │  (Mobile/Desktop)  │
                                          └───────────────────┘
```

## Installation

### Prerequisites

- **Node.js >= 18**
- Enterprise WeChat account (with bot creation permission)
- Claude Code

### Step 1: Create Enterprise WeChat Bot

1. Login to WeChat Work admin portal: https://work.weixin.qq.com
2. Go to "Management Tools" → "Smart Bot"
3. Click "Create Bot" → "Manual Creation"
4. Fill in bot name (e.g., "Claude Approval Assistant")
5. In "API Configuration":
   - Select "Use Long Connection"
   - Click "Get Secret"
6. Record **Bot ID** and **Secret**

### Step 2: Run Configuration Wizard

```bash
npx @vrs-soft/wecom-aibot-mcp
```

The wizard will guide you through:
1. Enter bot name (for identification)
2. Enter Bot ID
3. Enter Secret
4. Send a message to the bot in WeChat to auto-detect user ID

Configuration will automatically:
- Write bot config to `~/.wecom-aibot-mcp/config.json`
- Write MCP config to `~/.claude.json`
- Register PermissionRequest hook to `~/.claude/settings.local.json`
- Install headless-mode skill to `~/.claude/skills/`
- Start MCP service in background

## Commands

| Command | Description |
|---------|-------------|
| `npx @vrs-soft/wecom-aibot-mcp` | First-time configuration wizard |
| `npx @vrs-soft/wecom-aibot-mcp --start` | Start MCP service in background |
| `npx @vrs-soft/wecom-aibot-mcp --stop` | Stop MCP service |
| `npx @vrs-soft/wecom-aibot-mcp --status` | View service status |
| `npx @vrs-soft/wecom-aibot-mcp --config` | Modify configuration |
| `npx @vrs-soft/wecom-aibot-mcp --add` | Add new bot |
| `npx @vrs-soft/wecom-aibot-mcp --delete` | Delete bot config |
| `npx @vrs-soft/wecom-aibot-mcp --uninstall` | Complete uninstall |
| `npx @vrs-soft/wecom-aibot-mcp --debug` | Start in foreground (debug mode) |
| `npx @vrs-soft/wecom-aibot-mcp --upgrade` | Force upgrade global configs |

## Quick Start

### Start Service

```bash
npx @vrs-soft/wecom-aibot-mcp --start
```

Output:
```
[mcp] MCP Server started in background
[mcp] HTTP endpoint: http://127.0.0.1:18963/mcp
[mcp] Health check: curl http://127.0.0.1:18963/health
[mcp] Stop service: npx @vrs-soft/wecom-aibot-mcp --stop
```

### Restart Claude Code

Run `/mcp` command and select "Reconnect" to reconnect MCP service.

## Usage Example

### Headless Mode (Remote Approval)

```
You: Now contact me via WeChat

Claude: Entered WeChat mode, all interactions will go through Enterprise WeChat.
WeChat receives: [cc-1] Entered WeChat mode, using bot "Work Bot".

[You leave computer, Claude needs to delete files]

WeChat receives approval card:
┌─────────────────────────┐
│ 【Pending】Bash          │
│ Command: rm -rf dist     │
│ [Allow Once] [Deny]      │
└─────────────────────────┘

[You tap "Allow Once" on phone]

Claude continues execution, sends result to WeChat.

You: I'm back

Claude: Exited WeChat mode, restored terminal interaction.
```

### Timeout Approval Configuration

Configure approval timeout in `~/.wecom-aibot-mcp/config.json`:

```json
{
  "botId": "bot-xxx",
  "secret": "sec-yyy",
  "targetUserId": "user1",
  "nameTag": "Bot 1",
  "autoApproveTimeout": 600
}
```

- `autoApproveTimeout`: Timeout in seconds (default 600s = 10 minutes)
- After timeout: operations in project directory are auto-allowed, operations outside are auto-denied

### Debug Mode

Use `--debug` to view hook script logs in terminal:

```bash
npx @vrs-soft/wecom-aibot-mcp --debug
```

## MCP Tools

| Tool | Description | Parameters |
|------|-------------|------------|
| `send_message` | Send message to WeChat | `content`, `target_user` |
| `get_pending_messages` | Get pending messages (long poll) | `clear`, `timeout_ms` |
| `enter_headless_mode` | Enter WeChat mode | `agent_name`, `robot_id` |
| `exit_headless_mode` | Exit WeChat mode | `agent_name` |
| `check_connection` | Check connection status | - |
| `list_robots` | List all bots | - |
| `get_connection_stats` | Get connection stats | `recent_logs` |

## Troubleshooting

### Authentication Failed (Error 40058)

1. New bot needs ~2 minutes to sync
2. Complete authorization: Bot details → Available permissions → Authorize
3. Verify Bot ID and Secret

### Connection Issues

```bash
# Check service status
curl http://127.0.0.1:18963/health

# View logs
tail -f ~/.wecom-aibot-mcp/connection.log

# Restart service
npx @vrs-soft/wecom-aibot-mcp --stop
npx @vrs-soft/wecom-aibot-mcp --start
```

## License

MIT

## Related Links

- [Enterprise WeChat Smart Bot Documentation](https://developer.work.weixin.qq.com/document/path/101039)
- [Claude Code Documentation](https://docs.anthropic.com/claude-code)
- [MCP Protocol Specification](https://modelcontextprotocol.io)