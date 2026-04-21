# wecom-aibot-mcp

[中文文档](README.md) | English

Enterprise WeChat AI Bot MCP Service - Remote Approval Channel for Claude Code

> Handle Claude Code approval requests via WeChat, even when away from your computer.

## Features

- 🔐 **Remote Approval**: Approve/deny sensitive operations (Bash/Write/Edit) via WeChat cards
- 🔍 **Full Command View**: Approval cards include a detail link — open in browser to view the complete command
- 💬 **Bidirectional Communication**: Real-time task progress notifications
- 📱 **Headless Mode**: Switch to WeChat interaction when leaving terminal
- 🤖 **Multi-bot Support**: Multiple bots for team and group chat scenarios
- 🌐 **Remote Deployment**: MCP server can be deployed on a remote host with Bearer Token auth
- 🔄 **Auto-reconnect**: Channel mode automatically reconnects after network interruption or server restart

## Architecture

```
┌─────────────────┐      MCP (stdio)      ┌──────────────────────┐
│  Claude Code    │  ──────────────────▶  │  Channel MCP Proxy   │
│  (MCP Client)   │  ◀──────────────────  │  (local, SSE client) │
└─────────────────┘                       └──────────────────────┘
                                                    │ SSE
                                                    ▼
                                          ┌─────────────────────┐
                                          │  wecom-aibot-mcp    │
                                          │  HTTP MCP Server    │
                                          │  (local or remote)  │
                                          └─────────────────────┘
                                                    │
                                            WebSocket Connection
                                                    ↓
                                          ┌─────────────────────┐
                                          │  Enterprise WeChat  │
                                          └─────────────────────┘
                                                    │
                                                    ↓
                                          ┌─────────────────────┐
                                          │  User WeChat Client │
                                          │  (Mobile/Desktop)   │
                                          └─────────────────────┘
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
npx @vrs-soft/wecom-aibot-mcp --setup
```

Choose the appropriate role flag:

| Command | Role | Description |
|---------|------|-------------|
| `--setup` | Interactive | Guides through local or remote setup |
| `--setup --server` | Server-side | Configure bot + Token, no local MCP config |
| `--setup --channel` | Channel client | Connect to remote server, write Channel MCP config |
| `--setup --server --channel` | Full local | HTTP + Channel full install |

**Start server after setup**:

```bash
npx @vrs-soft/wecom-aibot-mcp --http-only --start
```

## Commands

| Command | Description |
|---------|-------------|
| `--start / --stop` | Start/stop background service |
| `--status` | View service status and bot list |
| `--config` | Modify default bot configuration |
| `--add / --delete` | Add/delete bot |
| `--set-token [token]` | Set Auth Token (for remote deployment) |
| `--set-token --clear` | Clear Auth Token |
| `--debug` | Start in foreground with debug output |
| `--http-only` | Start HTTP MCP Server only (server-side use) |
| `--channel-only` | Configure Channel MCP only (requires `MCP_URL`) |
| `--clean-cache` | Clear CC registry cache |
| `--upgrade` | Force upgrade global configs |
| `--uninstall` | Complete uninstall |

## Run Modes

| | Channel Mode | HTTP Mode |
|-|-------------|-----------|
| Message delivery | SSE push (instant) | `/loop` heartbeat polling |
| Latency | Immediate | ≤1 minute |
| Claude account | claude.ai direct only | Any (including API relay) |
| Reconnect | Auto (including server restart) | Auto via heartbeat |

To enter WeChat mode, tell Claude: **"Now contact me via WeChat"** — this triggers the `headless-mode` skill automatically.

**Claude startup command for Channel mode**:

```bash
claude --dangerously-load-development-channels server:wecom-aibot-channel
```

## Usage Example

### Headless Mode (Remote Approval)

```
You: Now contact me via WeChat

Claude: Entered WeChat mode. All interactions will go through Enterprise WeChat.

[You leave the computer. Claude needs to run a command.]

WeChat receives approval card:
┌──────────────────────────────┐
│ 【Pending Approval】Bash      │
│ Command: npm run build...    │
│ 📋 TaskID: approval_xxx      │
│ [Allow Once] [Default] [Deny]│
│ Details: View full command   │
└──────────────────────────────┘

[Tap "Allow Once" on phone, or open "View full command" to see complete output]

Claude continues execution and sends the result to WeChat.

You: I'm back

Claude: Exited WeChat mode.
```

### Timeout Auto-Approval

Configure in the bot config file or via `wecom-aibot.json`:

```json
{
  "autoApproveTimeout": 600
}
```

- `autoApproveTimeout`: Timeout in seconds (default 600s = 10 minutes)
- After timeout: operations **within** the project directory are auto-allowed; operations outside or delete commands are auto-denied

## Troubleshooting

```bash
# Check if service is running
curl http://127.0.0.1:18963/health

# Channel unavailable ("Channels are not currently available")
# → Using API key or relay service? Switch to HTTP mode instead.

# Channel fails to reconnect after server restart
# → Auto-reconnect triggers within 5 seconds; no manual action needed.
#    Requires v2.4.13 or later.

# Approval detail page shows "Unauthorized"
# → Upgrade to v2.4.14 or later; the /approval/ path is now auth-exempt.

# Port conflict
lsof -i :18963 | grep LISTEN
kill <PID>

# Clean up stale ccId registrations after disconnect
npx @vrs-soft/wecom-aibot-mcp --clean-cache
```

## MCP Tools

| Tool | Description | Key Parameters |
|------|-------------|----------------|
| `send_message` | Send message to WeChat | `content`, `cc_id`, `target_user` |
| `get_pending_messages` | Get pending messages (long poll) | `cc_id`, `timeout_ms` |
| `enter_headless_mode` | Enter WeChat mode | `cc_id`, `robot_id`, `mode` |
| `exit_headless_mode` | Exit WeChat mode | `cc_id` |
| `check_connection` | Check WebSocket connection status | - |
| `list_robots` | List all configured bots | - |
| `get_connection_stats` | Get connection stats and logs | `recent_logs` |

## License

MIT · [Enterprise WeChat Bot Docs](https://developer.work.weixin.qq.com/document/path/101039) · [Channels Reference](https://code.claude.com/docs/en/channels-reference)
