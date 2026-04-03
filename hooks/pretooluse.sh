#!/bin/bash
# PreToolUse hook for WeChat approval
# Blocks until user responds in WeChat

# Read hook input from stdin
INPUT=$(cat)

# Extract tool name
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')
TOOL_INPUT=$(echo "$INPUT" | jq -c '.tool_input // {}')

# Skip for MCP tools
if [[ "$TOOL_NAME" == mcp__* ]]; then
  exit 0
fi

# Skip for safe read-only tools
case "$TOOL_NAME" in
  Read|Glob|Grep|TaskList|TaskGet|TaskCreate|TaskUpdate|CronList|AskUserQuestion|Skill|ListMcpResourcesTool|EnterPlanMode|ExitPlanMode)
    exit 0
    ;;
esac

# Get port
PORT_FILE="$HOME/.wecom-aibot-mcp/port"
if [ ! -f "$PORT_FILE" ]; then
  exit 0
fi
PORT=$(cat "$PORT_FILE")

# Check server health (quick 2s timeout)
HEALTH=$(curl -s -m 2 "http://localhost:$PORT/health" 2>/dev/null)
if ! echo "$HEALTH" | grep -q '"status":"ok"'; then
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
    # Output JSON to stdout with permission decision
    printf '%s\n' '{"hookSpecificOutput":{"permissionDecision":"allow"}}'
    exit 0
    ;;
  deny)
    printf '%s\n' "{\"hookSpecificOutput\":{\"permissionDecision\":\"deny\"},\"systemMessage\":\"$REASON\"}" >&2
    exit 2
    ;;
  *)
    # ask or unknown - fall through to default permission handling
    exit 0
    ;;
esac