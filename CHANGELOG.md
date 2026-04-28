# Changelog

All notable changes to this project will be documented in this file.

## [2.4.21] - 2026-04-28

### Changed
- License changed from MIT to GPL-3.0; LICENSE file added with the official text from https://www.gnu.org/licenses/gpl-3.0.txt

### Added
- DESIGN.md "待完成设计" section now lists three known design gaps surfaced by the v2.4.20 incident: daemon-level WebSocket auto-reconnect on `onClose`, per-CC `check_connection`, and an admin endpoint to unregister a single ccId

## [2.4.20] - 2026-04-26

### Fixed
- Channel server now writes `wecom-aibot.json` and installs the headless-mode skill into the agent's local project directory after `enter_headless_mode`. Previously these file operations ran on the HTTP MCP host, so in remote deployments the agent's project was missing both files — the permission hook would `exit 0` (silently bypassing approval) and the agent had no skill template to follow



### Fixed
- Approval result message no longer shows duplicate label prefix (e.g. `执行命令: 执行命令: ...`) — the label is now output once from the stored description
- Timeout auto-approval result no longer shows `**执行命令**` header before the command block
- Approval card subtitle no longer shows `📋 TaskID` — taskId remains visible on the detail page

## [2.4.17] - 2026-04-21

### Fixed
- Channel reconnect now saves `robot_id` and `project_dir` on first `enter_headless_mode` call and reuses them during auto-reconnect, ensuring the server can correctly re-register the ccId after restart

## [2.4.16] - 2026-04-20

### Fixed
- Approval result messages are now truncated to 100 characters for manual approvals to reduce verbosity
- Timeout auto-approval messages now include the full command in Markdown code block format
- Approval detail pages are now retained for 30 minutes (up from 15 minutes)
- Timeout approval decisions no longer immediately delete the detail page — details remain viewable for 30 minutes after decision

## [2.4.15] - 2026-04-19

### Added
- English documentation as primary README; Chinese documentation moved to README_ZH.md

## [2.4.14] - 2026-04-18

### Fixed
- `/approval/` detail page now returns 200 instead of 401 when Bearer Token auth is enabled — the path is now excluded from auth checks

## [2.4.13] - 2026-04-18

### Fixed
- Channel SSE fails to reconnect after HTTP MCP server restart: added reconnect logic to the `!res.ok` branch, including re-calling `enter_headless_mode` to re-register the ccId, and resetting `httpSessionId` to prevent stale session reuse

## [2.4.12] - 2026-04-17

### Changed
- Removed `autoApprove` toggle; timeout-based auto-decision is now always active
- Pre-approved common MCP tool wildcards in default allow list

### Fixed
- `stopServer` now handles stale/missing PID file gracefully with port-based process fallback
- Management commands added to `skipEnsure` whitelist to prevent accidental global config overwrite

## [2.4.11] - 2026-04-16

### Added
- Approval card now includes a detail link for viewing the full command in browser
- Long descriptions are truncated in the card with a link to the full `/approval/:taskId` detail page

### Fixed
- Channel mode `enter_headless_mode` now registers the local `active-projects` index correctly

## [2.4.10] - 2026-04-15

### Fixed
- Strengthened "reply before executing" rule in MCP server instructions
- Hook timeout deadlock prevention: SIGTERM trap + adjusted default timeout

## [2.4.9] - 2026-04-14

### Fixed
- `enter_headless_mode` now writes `mode` field to `wecom-aibot.json`
- Timeout auto-approval: temporary directory whitelist security fix
- Hook now uses PID process tree to match project, fixing multi-window approval routing

## [2.4.8] - 2026-04-13

### Added
- Multi-bot support: multiple bots for team and group chat scenarios
- `doc_mcp_url` field support for robot config (WeCom document capability)

## [2.4.0] – [2.4.7] - 2026-04-10 ~ 2026-04-12

### Added
- Channel mode (SSE push) as alternative to HTTP polling mode
- `channel-server.ts`: transparent MCP proxy + SSE channel wake-up capability
- Auto-reconnect on SSE stream end or error (3-second retry)
- SSE heartbeat comment (`: heartbeat`) every 15 seconds to keep TCP alive
- Bearer Token auth for remote deployment (`--set-token`)
- `--http-only` flag: start HTTP MCP server only (server-side use)
- `--channel-only` flag: configure Channel MCP only
- Remote deployment support with Bearer Token authentication
- `get_connection_stats` tool for connection stats and logs

### Fixed
- `httpSessionId` reset on reconnect to prevent stale session reuse

## [1.4.0] – [2.3.x] - 2026-03-01 ~ 2026-04-09

### Added
- `ccId` registry mechanism for multi-session support
- Long-poll support in `get_pending_messages` (up to 60 seconds)
- Auto-approval timeout with configurable `autoApproveTimeout` (default 600s)
- Project-level config file `wecom-aibot.json` as ownership proof
- `enter_headless_mode` / `exit_headless_mode` tools
- Group chat support: reply routed by `chatid`
- PermissionRequest hook integration for approval flow
- `--setup` configuration wizard with role flags (`--server`, `--channel`)
- `--clean-cache` command to clear stale ccId registrations
- `--upgrade` command to force upgrade global configs
- `--uninstall` command for complete removal

### Fixed
- Approval polling changed to infinite wait (no timeout)
- MCP config `type` field added to fix schema validation error

## [1.0.0] – [1.3.x] - 2026-01-01 ~ 2026-02-28

### Added
- Initial release: Enterprise WeChat AI Bot MCP Service
- WebSocket connection to Enterprise WeChat
- Approval cards with Allow/Deny buttons for Bash/Write/Edit operations
- `send_message`, `get_pending_messages`, `check_connection`, `list_robots` tools
- `--start` / `--stop` background service management
- `--status`, `--config`, `--add`, `--delete` management commands
- `--debug` foreground mode with debug output
- Automatic `headless-mode` skill installation
- Auto user ID detection on first message
- Multi-instance support with per-project state
- Non-blocking approval to prevent connection drop during long waits
