#!/bin/bash
# wecom-aibot-mcp PermissionRequest hook
# HTTP Transport 版本
#
# 固定端口: 18963
# 从 headless-{PID} 读取 projectDir

MCP_PORT=18963
CONFIG_DIR="$HOME/.wecom-aibot-mcp"

# 读取 hook 输入
INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')
TOOL_INPUT=$(echo "$INPUT" | jq -c '.tool_input // {}')

echo "[$(date '+%H:%M:%S')] Hook called: $TOOL_NAME" >> /tmp/permission-hook.log

# MCP 工具本身不需要拦截
if [[ "$TOOL_NAME" == mcp__* ]]; then
  printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
  exit 0
fi

# 只读工具不需要拦截
case "$TOOL_NAME" in
  Read|Glob|Grep|LS|TaskList|TaskGet|TaskOutput|TaskStop|CronList|CronCreate|CronDelete|AskUserQuestion|Skill|ListMcpResourcesTool|EnterPlanMode|ExitPlanMode|WebSearch|WebFetch|NotebookEdit)
    printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
    exit 0
    ;;
esac

# 查找当前进程对应的 headless 状态文件
HEADLESS_FILE=""
PARENT_PID=$PPID

# 向上遍历进程树查找 headless 文件
for i in {1..5}; do
  if [[ -z "$PARENT_PID" ]] || [[ "$PARENT_PID" -eq 1 ]]; then
    break
  fi

  CANDIDATE="$CONFIG_DIR/headless-$PARENT_PID"
  if [[ -f "$CANDIDATE" ]]; then
    HEADLESS_FILE="$CANDIDATE"
    break
  fi

  # 检查子进程
  CHILD_PIDS=$(pgrep -P "$PARENT_PID" 2>/dev/null)
  for CHILD_PID in $CHILD_PIDS; do
    CANDIDATE="$CONFIG_DIR/headless-$CHILD_PID"
    if [[ -f "$CANDIDATE" ]]; then
      HEADLESS_FILE="$CANDIDATE"
      break 2
    fi
  done

  PARENT_PID=$(ps -o ppid= -p "$PARENT_PID" 2>/dev/null | tr -d ' ')
done

# Fallback: 使用最新的 headless 文件
if [[ -z "$HEADLESS_FILE" ]]; then
  HEADLESS_FILE=$(ls -t "$CONFIG_DIR"/headless-* 2>/dev/null | head -1)
fi

# 不在 headless 模式，回退默认 UI
if [[ -z "$HEADLESS_FILE" ]] || [[ ! -f "$HEADLESS_FILE" ]]; then
  exit 0
fi

# 从 headless 文件读取 projectDir
PROJECT_DIR=$(cat "$HEADLESS_FILE" 2>/dev/null | jq -r '.projectDir // empty')
if [[ -z "$PROJECT_DIR" ]]; then
  exit 0
fi

echo "[$(date '+%H:%M:%S')] Headless mode, projectDir: $PROJECT_DIR" >> /tmp/permission-hook.log

# 检查 MCP Server 是否在线
HEALTH=$(curl -s -m 2 "http://127.0.0.1:$MCP_PORT/health" 2>/dev/null)
if ! echo "$HEALTH" | jq -e '.status == "ok"' > /dev/null 2>&1; then
  echo "[$(date '+%H:%M:%S')] MCP Server not healthy" >> /tmp/permission-hook.log
  exit 0
fi

# 发送审批请求
BODY=$(jq -n --arg tool_name "$TOOL_NAME" --argjson tool_input "$TOOL_INPUT" --arg project_dir "$PROJECT_DIR" \
  '{"tool_name":$tool_name,"tool_input":$tool_input,"projectDir":$project_dir}')

RESPONSE=$(curl -s -m 10 -X POST "http://127.0.0.1:$MCP_PORT/approve" \
  -H "Content-Type: application/json" \
  -d "$BODY")

TASK_ID=$(echo "$RESPONSE" | jq -r '.taskId // empty')
if [[ -z "$TASK_ID" ]]; then
  echo "[$(date '+%H:%M:%S')] Failed to send approval request" >> /tmp/permission-hook.log
  exit 0
fi

echo "[$(date '+%H:%M:%S')] Approval request sent: $TASK_ID" >> /tmp/permission-hook.log

# 轮询审批结果（带超时：10 分钟）
POLL_COUNT=0
MAX_POLL=300  # 300 * 2秒 = 600秒 = 10分钟

while [[ $POLL_COUNT -lt $MAX_POLL ]]; do
  sleep 2
  POLL_COUNT=$((POLL_COUNT + 1))

  STATUS=$(curl -s -m 3 "http://127.0.0.1:$MCP_PORT/approval_status/$TASK_ID" 2>/dev/null)
  RESULT=$(echo "$STATUS" | jq -r '.result // empty')

  if [[ "$RESULT" == "allow-once" || "$RESULT" == "allow-always" ]]; then
    echo "[$(date '+%H:%M:%S')] Approved: $RESULT" >> /tmp/permission-hook.log
    printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
    exit 0
  elif [[ "$RESULT" == "deny" ]]; then
    echo "[$(date '+%H:%M:%S')] Denied" >> /tmp/permission-hook.log
    printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"用户拒绝"}}}'
    exit 0
  fi

  # 每 30 次轮询（1分钟）打印一次日志
  if [[ $((POLL_COUNT % 30)) -eq 0 ]]; then
    echo "[$(date '+%H:%M:%S')] Still waiting... ($((POLL_COUNT * 2))s)" >> /tmp/permission-hook.log
  fi
done

# 超时处理：拒绝操作
echo "[$(date '+%H:%M:%S')] Timeout after 10 minutes" >> /tmp/permission-hook.log
printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"审批超时（10分钟）"}}}'