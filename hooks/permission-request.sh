#!/bin/bash
# wecom-aibot-mcp PermissionRequest hook
# 简化版本：只发送请求和查询状态
# 智能代批逻辑在 MCP Server 中执行

MCP_PORT=18963
CONFIG_DIR="$HOME/.wecom-aibot-mcp"

# 读取 hook 输入
INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')
TOOL_INPUT=$(echo "$INPUT" | jq -c '.tool_input // {}')

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

# 查找 headless 状态文件
HEADLESS_FILE=""
PARENT_PID=$PPID

for i in {1..5}; do
  if [[ -z "$PARENT_PID" ]] || [[ "$PARENT_PID" -eq 1 ]]; then
    break
  fi

  CANDIDATE="$CONFIG_DIR/headless-$PARENT_PID"
  if [[ -f "$CANDIDATE" ]]; then
    HEADLESS_FILE="$CANDIDATE"
    break
  fi

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

# 检查 MCP Server 是否在线
HEALTH=$(curl -s -m 2 "http://127.0.0.1:$MCP_PORT/health" 2>/dev/null)
if ! echo "$HEALTH" | jq -e '.status == "ok"' > /dev/null 2>&1; then
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
  exit 0
fi

# 轮询审批结果
# MCP Server 会处理超时和智能代批
while true; do
  sleep 2

  HTTP_CODE=$(curl -s -o /tmp/approval_resp_$$ -w "%{http_code}" -m 3 "http://127.0.0.1:$MCP_PORT/approval_status/$TASK_ID" 2>/dev/null)
  STATUS=$(cat /tmp/approval_resp_$$ 2>/dev/null)
  rm -f /tmp/approval_resp_$$
  RESULT=$(echo "$STATUS" | jq -r '.result // empty')

  if [[ "$RESULT" == "allow-once" || "$RESULT" == "allow-always" ]]; then
    printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
    exit 0
  elif [[ "$RESULT" == "deny" ]]; then
    printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"用户拒绝或超时自动拒绝"}}}'
    exit 0
  elif [[ "$HTTP_CODE" == "404" ]]; then
    # 审批记录已被清除（超时审批后立即删除），视为已批准
    printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
    exit 0
  fi
done