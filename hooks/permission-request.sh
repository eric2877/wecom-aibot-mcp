#!/bin/bash
# PermissionRequest hook for WeChat approval
# Blocks until user responds in WeChat

LOG="/tmp/permission-hook.log"

# Read hook input from stdin
INPUT=$(cat)
echo "[$(date '+%H:%M:%S')] Hook called: $INPUT" >> "$LOG"

# Extract permission request details
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')
TOOL_INPUT=$(echo "$INPUT" | jq -c '.tool_input // {}')
echo "[$(date '+%H:%M:%S')] Tool: $TOOL_NAME" >> "$LOG"

# Skip for MCP tools
if [[ "$TOOL_NAME" == mcp__* ]]; then
  printf '%s\n' '{"decision": "allow"}'
  exit 0
fi

# Skip for safe read-only tools
case "$TOOL_NAME" in
  Read|Glob|Grep|TaskList|TaskGet|TaskCreate|TaskUpdate|CronList|AskUserQuestion|Skill|ListMcpResourcesTool|EnterPlanMode|ExitPlanMode)
    printf '%s\n' '{"decision": "allow"}'
    exit 0
    ;;
esac

# Get port
PORT_FILE="$HOME/.wecom-aibot-mcp/port"
if [ ! -f "$PORT_FILE" ]; then
  # No server, fall through to default handling
  exit 0
fi
PORT=$(cat "$PORT_FILE")

# Check server health (quick 2s timeout)
HEALTH=$(curl -s -m 2 "http://localhost:$PORT/health" 2>/dev/null)
if ! echo "$HEALTH" | grep -q '"status":"ok"'; then
  # Server not healthy, fall through
  exit 0
fi

# Send approval request - BLOCK until user responds
RESPONSE=$(curl -s -X POST "http://localhost:$PORT/approve" \
  -H "Content-Type: application/json" \
  -d "{\"tool_name\": \"$TOOL_NAME\", \"tool_input\": $TOOL_INPUT}")

# Parse decision
DECISION=$(echo "$RESPONSE" | jq -r '.decision // "ask"')
REASON=$(echo "$RESPONSE" | jq -r '.reason // ""')

case "$DECISION" in
  allow)
    printf '%s\n' '{"decision": "allow"}'
    exit 0
    ;;
  deny)
    printf '%s\n' "{\"decision\": \"deny\", \"reason\": \"$REASON\"}" >&2
    exit 2
    ;;
  *)
    # ask - fall through to default UI
    exit 0
    ;;
esac