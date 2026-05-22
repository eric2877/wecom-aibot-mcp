/**
 * 配置向导模块
 *
 * 首次运行时引导用户配置 daemon 地址和 Auth Token
 *
 * 配置存储位置：
 * - 安装记录：~/.wecom-aibot-mcp/version.json
 * - MCP 配置：~/.claude.json (仅 URL)
 */
import * as readline from 'readline';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { fileURLToPath } from 'url';
import { logger } from './logger.js';

const CONFIG_DIR = path.join(os.homedir(), '.wecom-aibot-mcp');
const VERSION_FILE = path.join(CONFIG_DIR, 'version.json');
const SERVER_CONFIG_FILE = path.join(CONFIG_DIR, 'server.json');
const CLAUDE_CONFIG_FILE = path.join(os.homedir(), '.claude.json');
const CLAUDE_SETTINGS_FILE = path.join(os.homedir(), '.claude', 'settings.local.json');
const HOOK_SCRIPT_PATH = path.join(CONFIG_DIR, 'permission-hook.sh');
const STOP_HOOK_SCRIPT_PATH = path.join(CONFIG_DIR, 'stop-hook.sh');

// Skill 模板路径（包内）- 使用 fileURLToPath 确保跨平台兼容
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 版本号（从 package.json 读取，全局共享）
export const VERSION: string = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8')).version;
const SKILL_TEMPLATE_DIR = path.join(__dirname, '..', 'skills', 'headless-mode');
const SKILL_TEMPLATE_FILE = path.join(SKILL_TEMPLATE_DIR, 'SKILL.md');

// MCP 工具权限列表（需要预授权以避免 headless 模式阻断）
const MCP_TOOL_PERMISSIONS = [
  'mcp__wecom-aibot__*',  // 允许所有 wecom-aibot 工具
];

// 确保配置目录存在（用于存储端口文件、hook脚本等运行时文件）
function ensureConfigDir() {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

// 获取 HTTP Server 的 auth token（从 server.json 读取）
export function getAuthToken(): string | undefined {
  if (!fs.existsSync(SERVER_CONFIG_FILE)) return undefined;
  try {
    const config = JSON.parse(fs.readFileSync(SERVER_CONFIG_FILE, 'utf-8'));
    return config.authToken || undefined;
  } catch {
    return undefined;
  }
}

// 删除配置（从 ~/.claude.json）
export function deleteConfig() {
  try {
    if (fs.existsSync(CLAUDE_CONFIG_FILE)) {
      const content = fs.readFileSync(CLAUDE_CONFIG_FILE, 'utf-8');
      const claudeConfig = JSON.parse(content);

      let changed = false;
      if (claudeConfig.mcpServers?.['wecom-aibot']) {
        delete claudeConfig.mcpServers['wecom-aibot'];
        console.log('[config] 已从 ~/.claude.json 删除 wecom-aibot 配置');
        changed = true;
      }
      if (claudeConfig.mcpServers?.['wecom-aibot-channel']) {
        delete claudeConfig.mcpServers['wecom-aibot-channel'];
        console.log('[config] 已从 ~/.claude.json 删除 wecom-aibot-channel 配置');
        changed = true;
      }
      if (changed) {
        fs.writeFileSync(CLAUDE_CONFIG_FILE, JSON.stringify(claudeConfig, null, 2));
      }
    }
  } catch (err) {
    logger.error('[config] 删除配置失败:', err);
  }
}

// 删除 PermissionRequest hook（从 ~/.claude/settings.local.json）
export function deleteHook() {
  try {
    if (fs.existsSync(CLAUDE_SETTINGS_FILE)) {
      const content = fs.readFileSync(CLAUDE_SETTINGS_FILE, 'utf-8');
      const settings = JSON.parse(content);
      let changed = false;

      if (settings.hooks && settings.hooks['PermissionRequest']) {
        // 只删除 wecom-aibot 相关的 hook
        settings.hooks['PermissionRequest'] = settings.hooks['PermissionRequest'].filter(
          (hook: any) => !hook.hooks?.some?.((h: any) => h.command?.includes?.('wecom-aibot-mcp'))
        );
        if (settings.hooks['PermissionRequest'].length === 0) {
          delete settings.hooks['PermissionRequest'];
        }
        console.log('[config] 已删除 PermissionRequest hook');
        changed = true;
      }

      // 移除 wecom-aibot 相关的 MCP 权限
      if (Array.isArray(settings.permissions?.allow)) {
        const before = settings.permissions.allow.length;
        settings.permissions.allow = settings.permissions.allow.filter(
          (p: string) => !/^mcp__wecom-aibot(-channel)?__/.test(p)
        );
        if (settings.permissions.allow.length !== before) {
          console.log(`[config] 已移除 ${before - settings.permissions.allow.length} 条 wecom-aibot MCP 权限`);
          changed = true;
        }
      }

      if (changed) {
        fs.writeFileSync(CLAUDE_SETTINGS_FILE, JSON.stringify(settings, null, 2));
      }

      // 删除 hook 脚本文件
      if (fs.existsSync(HOOK_SCRIPT_PATH)) {
        fs.unlinkSync(HOOK_SCRIPT_PATH);
        console.log('[config] 已删除 hook 脚本文件');
      }
    }
  } catch (err) {
    logger.error('[config] 删除 hook 失败:', err);
  }
}

// 删除 skill 文件
export function deleteSkills() {
  try {
    const skillDir = path.join(os.homedir(), '.claude', 'skills', 'headless-mode');
    if (fs.existsSync(skillDir)) {
      fs.rmSync(skillDir, { recursive: true });
      console.log('[config] 已删除 skill 文件');
    }
  } catch (err) {
    logger.error('[config] 删除 skill 失败:', err);
  }
}

// 完全卸载（删除所有相关配置）
export function uninstall() {
  console.log('\n[config] 开始卸载 wecom-aibot-mcp...\n');

  deleteConfig();  // 删除 ~/.claude.json 中的配置
  deleteHook();
  deleteSkills();

  // 删除全局 headless 状态索引文件（可能在同一目录）
  const headlessIndexFile = path.join(CONFIG_DIR, 'headless-index.json');
  if (fs.existsSync(headlessIndexFile)) {
    try {
      fs.unlinkSync(headlessIndexFile);
      console.log('[config] 已删除 headless 状态索引');
    } catch (err) {
      logger.error('[config] 删除 headless 状态索引失败:', err);
    }
  }

  // 删除整个配置目录（包括 robot-*.json、hook 脚本、日志等）
  if (fs.existsSync(CONFIG_DIR)) {
    try {
      const files = fs.readdirSync(CONFIG_DIR);
      for (const file of files) {
        const filePath = path.join(CONFIG_DIR, file);
        try {
          if (fs.statSync(filePath).isDirectory()) {
            fs.rmSync(filePath, { recursive: true, force: true });
          } else {
            fs.unlinkSync(filePath);
          }
        } catch {
          // 忽略单个文件删除失败
        }
      }
      try {
        fs.rmSync(CONFIG_DIR, { recursive: true, force: true });
        console.log('[config] 已删除配置目录');
      } catch {
        console.log('[config] 配置目录已清空（部分文件可能被占用）');
      }
    } catch (err) {
      logger.error('[config] 删除配置目录失败:', err);
    }
  }

  console.log('\n[config] 卸载完成');
  console.log('[config] 如需重新安装，请运行: npx @vrs-soft/wecom-aibot-mcp\n');
}

// 生成并写入 hook 脚本（HTTP Transport 版本）
function writeHookScript() {
  const script = `#!/bin/bash
# wecom-aibot-mcp PermissionRequest hook
# HTTP Transport 版本
#
# 固定端口: 18963
# 通过 PID 树查 ~/.wecom-aibot-mcp/active-projects.json 匹配项目，读 wechatMode 开关

MCP_PORT=18963

# 先保存输入（只能读一次）
INPUT=$(cat)

# 日志输出：--debug 模式下输出到 stderr，否则静默
DEBUG_FILE="$HOME/.wecom-aibot-mcp/debug"
log_debug() {
  if [[ -f "$DEBUG_FILE" ]]; then
    echo "$1" >&2
  fi
}

log_debug "[$(date)] Hook called. TOOL_NAME: $(echo "$INPUT" | jq -r '.tool_name')"

TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')

# MCP 工具本身不需要拦截
if [[ "$TOOL_NAME" == mcp__* ]]; then
  log_debug "[$(date)] Allowed: MCP tool"
  printf '%s\\n' '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
  exit 0
fi

# 只读工具不需要拦截
case "$TOOL_NAME" in
  Read|Glob|Grep|LS|TaskList|TaskGet|TaskOutput|TaskStop|CronList|CronCreate|CronDelete|AskUserQuestion|Skill|ListMcpResourcesTool|EnterPlanMode|ExitPlanMode|WebSearch|WebFetch|NotebookEdit)
    log_debug "[$(date)] Allowed: read-only tool"
    printf '%s\\n' '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
    exit 0
    ;;
esac

# 通过进程树匹配活跃项目（以 Claude 进程为准，不依赖 pwd）
ACTIVE_INDEX="$HOME/.wecom-aibot-mcp/active-projects.json"
log_debug "[$(date)] Checking active-projects index via PID tree (pid=$$, ppid=$PPID)"

if [[ ! -f "$ACTIVE_INDEX" ]]; then
  log_debug "[$(date)] No active-projects index, exit 0"
  exit 0
fi

# 沿进程树向上查找，深度 8 层
PROJECT_DIR=""
SEARCH_PID=$PPID
for i in {1..8}; do
  if [[ -z "$SEARCH_PID" ]] || [[ "$SEARCH_PID" -le 1 ]]; then
    break
  fi
  MATCH=$(jq -r --argjson p "$SEARCH_PID" '.[] | select(.pid==$p) | .projectDir' "$ACTIVE_INDEX" 2>/dev/null)
  if [[ -n "$MATCH" ]]; then
    PROJECT_DIR="$MATCH"
    log_debug "[$(date)] Found project via PID $SEARCH_PID (depth $i): $PROJECT_DIR"
    break
  fi
  SEARCH_PID=$(ps -o ppid= -p "$SEARCH_PID" 2>/dev/null | tr -d ' ')
done

if [[ -z "$PROJECT_DIR" ]]; then
  log_debug "[$(date)] No PID match in process tree, exit 0"
  exit 0
fi

CONFIG_FILE="$PROJECT_DIR/.claude/wecom-aibot.json"
log_debug "[$(date)] Found project: $PROJECT_DIR"

# 配置文件不存在，不在微信模式
if [[ ! -f "$CONFIG_FILE" ]]; then
  log_debug "[$(date)] No wecom-aibot.json config, exit 0"
  exit 0
fi

# 检查 wechatMode 是否为 true（微信模式开关）
WECHAT_MODE=$(jq -r '.wechatMode // false' "$CONFIG_FILE" 2>/dev/null)
log_debug "[$(date)] wechatMode: $WECHAT_MODE"
if [[ "$WECHAT_MODE" != "true" ]]; then
  log_debug "[$(date)] wechatMode not true, exit 0"
  exit 0
fi

# 确定 MCP Server 地址
# channel 模式直接使用远程地址，http 模式先试本地再回退远程
MODE=$(jq -r '.mode // "http"' "$CONFIG_FILE" 2>/dev/null)
MCP_BASE_URL="http://127.0.0.1:$MCP_PORT"
AUTH_ARGS=()

_try_remote() {
  CLAUDE_JSON="$HOME/.claude.json"
  if [[ ! -f "$CLAUDE_JSON" ]]; then
    log_debug "[$(date)] No ~/.claude.json found, exit 0"
    exit 0
  fi
  REMOTE_URL=$(jq -r '.mcpServers["wecom-aibot-channel"].env.MCP_URL // empty' "$CLAUDE_JSON" 2>/dev/null)
  REMOTE_TOKEN=$(jq -r '.mcpServers["wecom-aibot-channel"].env.MCP_AUTH_TOKEN // empty' "$CLAUDE_JSON" 2>/dev/null)
  if [[ -z "$REMOTE_URL" ]]; then
    log_debug "[$(date)] No remote URL configured, exit 0"
    exit 0
  fi
  REMOTE_HEALTH=$(curl -s -m 5 \${REMOTE_TOKEN:+-H "Authorization: Bearer $REMOTE_TOKEN"} "$REMOTE_URL/health" 2>/dev/null)
  log_debug "[$(date)] Remote health check ($REMOTE_URL): $REMOTE_HEALTH"
  if echo "$REMOTE_HEALTH" | jq -e '.status == "ok"' > /dev/null 2>&1; then
    MCP_BASE_URL="$REMOTE_URL"
    [[ -n "$REMOTE_TOKEN" ]] && AUTH_ARGS=(-H "Authorization: Bearer $REMOTE_TOKEN")
    log_debug "[$(date)] Using remote server: $MCP_BASE_URL"
  else
    log_debug "[$(date)] Remote health check failed, exit 0"
    exit 0
  fi
}

if [[ "$MODE" == "channel" ]]; then
  # channel 模式：直接使用远程地址，跳过本地检查
  log_debug "[$(date)] Channel mode, using remote server directly"
  _try_remote
else
  # http 模式：本地优先，失败则尝试远程
  HEALTH=$(curl -s -m 2 "$MCP_BASE_URL/health" 2>/dev/null)
  log_debug "[$(date)] Local health check: $HEALTH"
  if ! echo "$HEALTH" | jq -e '.status == "ok"' > /dev/null 2>&1; then
    log_debug "[$(date)] Local server not available, trying remote channel config..."
    _try_remote
  fi
fi

# 读取当前项目使用的机器人名称和 ccId
ROBOT_NAME=$(jq -r '.robotName // empty' "$CONFIG_FILE" 2>/dev/null)
CC_ID=$(jq -r '.ccId // empty' "$CONFIG_FILE" 2>/dev/null)

# 发送审批请求（使用 pwd 作为 projectDir）
TOOL_INPUT=$(echo "$INPUT" | jq -c '.tool_input // {}')
BODY=$(jq -n --arg tool_name "$TOOL_NAME" --argjson tool_input "$TOOL_INPUT" --arg project_dir "$PROJECT_DIR" --arg robot_name "$ROBOT_NAME" --arg cc_id "$CC_ID" \\
  '{"tool_name":$tool_name,"tool_input":$tool_input,"projectDir":$project_dir,"robotName":$robot_name,"ccId":$cc_id}')

log_debug "[$(date)] Sending approval request..."
RESPONSE=$(curl -s -m 10 -X POST "$MCP_BASE_URL/approve" \\
  "\${AUTH_ARGS[@]}" \\
  -H "Content-Type: application/json" \\
  -d "$BODY")

log_debug "[$(date)] Approval response: $RESPONSE"
TASK_ID=$(echo "$RESPONSE" | jq -r '.taskId // empty')
if [[ -z "$TASK_ID" ]]; then
  log_debug "[$(date)] No taskId, exit 0"
  exit 0
fi

log_debug "[$(date)] Waiting for approval, taskId: $TASK_ID"

# 轮询审批结果（带超时：从配置读取）
AUTO_APPROVE_TIMEOUT=$(jq -r '.autoApproveTimeout // 300' "$CONFIG_FILE" 2>/dev/null)
# 超时时间（秒），转换为轮询次数（每次 sleep 2秒）
# 使用向上取整补偿整数截断：MAX_POLL = ceil(timeout/2) = (timeout+1)/2
MAX_POLL=$(( (AUTO_APPROVE_TIMEOUT + 1) / 2 ))
if [[ $MAX_POLL -lt 1 ]]; then
  MAX_POLL=1
fi
POLL_COUNT=0

log_debug "[$(date)] autoApproveTimeout: $AUTO_APPROVE_TIMEOUT seconds, MAX_POLL: $MAX_POLL (actual wait: ~$((MAX_POLL * 2))s)"

while [[ $POLL_COUNT -lt $MAX_POLL ]]; do
  sleep 2
  POLL_COUNT=$((POLL_COUNT + 1))

  STATUS=$(curl -s -m 3 "\${AUTH_ARGS[@]}" "$MCP_BASE_URL/approval_status/$TASK_ID" 2>/dev/null)
  RESULT=$(echo "$STATUS" | jq -r '.result // empty')
  log_debug "[$(date)] Poll $POLL_COUNT/$MAX_POLL: result=$RESULT"

  if [[ "$RESULT" == "allow-once" || "$RESULT" == "allow-always" ]]; then
    log_debug "[$(date)] Approved by user"
    printf '%s\\n' '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
    exit 0
  elif [[ "$RESULT" == "deny" ]]; then
    log_debug "[$(date)] Denied by user"
    printf '%s\\n' '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"用户拒绝"}}}'
    exit 0
  fi
done

log_debug "[$(date)] Timeout reached, executing smart auto-approval"

# 超时处理：必须立即决策，Claude Code 的 hook timeout 会杀掉阻塞进程。
# 规则：删除命令→拒绝，项目内操作→允许，项目外操作→拒绝

# 检查是否是删除命令（仅匹配命令行本身，不匹配 heredoc 内容）
IS_DELETE=0
if [[ "$TOOL_NAME" == "Bash" ]]; then
  # 只取命令的第一行（避免 heredoc 内容干扰）
  FIRST_LINE=$(echo "$TOOL_INPUT" | jq -r '.command // empty' | head -1)
  log_debug "[$(date)] Checking delete: FIRST_LINE=$FIRST_LINE"
  if [[ "$FIRST_LINE" == rm\\ * ]] || [[ "$FIRST_LINE" == rm ]] \\
     || echo "$FIRST_LINE" | grep -qE '(^|[;&|(] *)(rm |rmdir )'; then
    IS_DELETE=1
  fi
fi

log_debug "[$(date)] IS_DELETE: $IS_DELETE"

# 删除操作 → 永远拒绝
if [[ $IS_DELETE -eq 1 ]]; then
  log_debug "[$(date)] Auto-deny: delete operation"
  # 通知 MCP Server 发送微信消息
  curl -s -m 5 -X POST "$MCP_BASE_URL/approval_timeout/$TASK_ID" "\${AUTH_ARGS[@]}" -H "Content-Type: application/json" -d '{"result":"deny","reason":"超时自动拒绝：删除操作需人工确认"}' > /dev/null 2>&1 &
  printf '%s\\n' '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"超时自动拒绝：删除操作需人工确认"}}}'
  exit 0
fi

# 检查操作路径是否在项目内
IS_IN_PROJECT=0

case "$TOOL_NAME" in
  Bash)
    CMD=$(echo "$TOOL_INPUT" | jq -r '.command // empty')
    EXEC_CWD=$(pwd)
    log_debug "[$(date)] Bash CMD=$CMD, EXEC_CWD=$EXEC_CWD"
    if [[ "$CMD" == *"$PROJECT_DIR"* ]]; then
      # 明确包含项目路径 → 项目内
      IS_IN_PROJECT=1
    elif echo "$CMD" | grep -qE '(^|[ \t])/[a-zA-Z0-9]'; then
      # 含有绝对路径：过滤掉项目路径和安全系统目录，看是否还有真正的项目外路径
      OUTSIDE=$(echo "$CMD" | grep -oE '(^| )/[a-zA-Z0-9][^ \t>|;&]*' | tr -d ' ' \
        | grep -v "^$PROJECT_DIR" \
        | grep -vE '^(/tmp/|/var/tmp/|/dev/null|/dev/stdin|/dev/stdout|/dev/stderr|/dev/fd/)')
      if [[ -z "$OUTSIDE" ]]; then
        # 绝对路径全是项目内或安全临时目录 → 以执行位置为准
        log_debug "[$(date)] Only safe abs paths, checking EXEC_CWD: $EXEC_CWD"
        if [[ "$EXEC_CWD" == "$PROJECT_DIR"* ]]; then
          IS_IN_PROJECT=1
        fi
      else
        log_debug "[$(date)] Outside abs path detected: $OUTSIDE"
        IS_IN_PROJECT=0
      fi
    else
      # 无绝对路径（相对路径或纯命令如 npm/git）→ 以执行位置为准
      log_debug "[$(date)] No absolute path, checking EXEC_CWD: $EXEC_CWD"
      if [[ "$EXEC_CWD" == "$PROJECT_DIR"* ]]; then
        IS_IN_PROJECT=1
      fi
    fi
    ;;
  Write|Edit)
    FILE_PATH=$(echo "$TOOL_INPUT" | jq -r '.file_path // empty')
    if [[ "$FILE_PATH" == "$PROJECT_DIR"* ]] || [[ "$FILE_PATH" != /* ]]; then
      IS_IN_PROJECT=1
    fi
    ;;
  *)
    FILE_PATH=$(echo "$TOOL_INPUT" | jq -r '.file_path // .path // .directory // empty')
    if [[ -n "$FILE_PATH" ]]; then
      if [[ "$FILE_PATH" == "$PROJECT_DIR"* ]] || [[ "$FILE_PATH" != /* ]]; then
        IS_IN_PROJECT=1
      fi
    fi
    ;;
esac

log_debug "[$(date)] IS_IN_PROJECT: $IS_IN_PROJECT"

# 根据项目内/外决策
if [[ $IS_IN_PROJECT -eq 1 ]]; then
  log_debug "[$(date)] Auto-allow: project operation"
  # 通知 MCP Server 发送微信消息
  curl -s -m 5 -X POST "$MCP_BASE_URL/approval_timeout/$TASK_ID" "\${AUTH_ARGS[@]}" -H "Content-Type: application/json" -d '{"result":"allow-once","reason":"超时自动允许：项目内操作"}' > /dev/null 2>&1 &
  printf '%s\\n' '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow","message":"超时自动允许：项目内操作"}}}'
else
  log_debug "[$(date)] Auto-deny: outside project"
  # 通知 MCP Server 发送微信消息
  curl -s -m 5 -X POST "$MCP_BASE_URL/approval_timeout/$TASK_ID" "\${AUTH_ARGS[@]}" -H "Content-Type: application/json" -d '{"result":"deny","reason":"超时自动拒绝：项目外操作需人工确认"}' > /dev/null 2>&1 &
  printf '%s\\n' '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"超时自动拒绝：项目外操作需人工确认"}}}'
fi
`;

  ensureConfigDir();
  fs.writeFileSync(HOOK_SCRIPT_PATH, script, { mode: 0o755 });
  console.log(`[config] Hook 脚本已写入: ${HOOK_SCRIPT_PATH}`);
}

// 生成并写入 Stop hook 脚本
// HTTP 模式使用：阻止 Claude 停止，提示调用 get_pending_messages 恢复轮询
function writeStopHookScript() {
  const script = `#!/bin/bash
# wecom-aibot-mcp Stop hook
# HTTP 模式使用：阻止 Claude 停止，提示调用 get_pending_messages 恢复轮询
#
# 固定端口: 18963
# 只检查 $(pwd)/.claude/wecom-aibot.json 的 wechatMode 字段

MCP_PORT=18963

# 先保存输入（Stop 事件数据）
INPUT=$(cat)

# 日志输出：--debug 模式下输出到 stderr，否则静默
DEBUG_FILE="$HOME/.wecom-aibot-mcp/debug"
log_debug() {
  if [[ -f "$DEBUG_FILE" ]]; then
    echo "$1" >&2
  fi
}

log_debug "[$(date)] Stop hook called. INPUT: \${INPUT:0:200}"

# 检查项目目录的微信模式配置文件
PROJECT_DIR=$(pwd)
CONFIG_FILE="$PROJECT_DIR/.claude/wecom-aibot.json"

log_debug "[$(date)] Checking config: $CONFIG_FILE"

# 配置文件不存在，不在微信模式，允许停止
if [[ ! -f "$CONFIG_FILE" ]]; then
  log_debug "[$(date)] No config file, exit 0 (allow stop)"
  exit 0
fi

# 检查 wechatMode 是否为 true（微信模式开关）
WECHAT_MODE=$(jq -r '.wechatMode // false' "$CONFIG_FILE" 2>/dev/null)
log_debug "[$(date)] wechatMode: $WECHAT_MODE"
if [[ "$WECHAT_MODE" != "true" ]]; then
  log_debug "[$(date)] wechatMode not true, exit 0 (allow stop)"
  exit 0
fi

# 确定 MCP Server 地址（本地优先，失败则尝试远程 channel 配置）
MCP_BASE_URL="http://127.0.0.1:$MCP_PORT"
AUTH_ARGS=()

HEALTH=$(curl -s -m 2 "$MCP_BASE_URL/health" 2>/dev/null)
log_debug "[$(date)] Local health check: $HEALTH"
if ! echo "$HEALTH" | jq -e '.status == "ok"' > /dev/null 2>&1; then
  CLAUDE_JSON="$HOME/.claude.json"
  if [[ -f "$CLAUDE_JSON" ]]; then
    REMOTE_URL=$(jq -r '.mcpServers["wecom-aibot-channel"].env.MCP_URL // empty' "$CLAUDE_JSON" 2>/dev/null)
    REMOTE_TOKEN=$(jq -r '.mcpServers["wecom-aibot-channel"].env.MCP_AUTH_TOKEN // empty' "$CLAUDE_JSON" 2>/dev/null)
    if [[ -n "$REMOTE_URL" ]]; then
      REMOTE_HEALTH=$(curl -s -m 5 \${REMOTE_TOKEN:+-H "Authorization: Bearer $REMOTE_TOKEN"} "$REMOTE_URL/health" 2>/dev/null)
      if echo "$REMOTE_HEALTH" | jq -e '.status == "ok"' > /dev/null 2>&1; then
        MCP_BASE_URL="$REMOTE_URL"
        [[ -n "$REMOTE_TOKEN" ]] && AUTH_ARGS=(-H "Authorization: Bearer $REMOTE_TOKEN")
        log_debug "[$(date)] Using remote server: $MCP_BASE_URL"
      else
        log_debug "[$(date)] MCP Server offline, exit 0 (allow stop)"
        exit 0
      fi
    else
      log_debug "[$(date)] MCP Server offline, exit 0 (allow stop)"
      exit 0
    fi
  else
    log_debug "[$(date)] MCP Server offline, exit 0 (allow stop)"
    exit 0
  fi
fi

# 获取 ccId
CC_ID=$(jq -r '.ccId // empty' "$CONFIG_FILE" 2>/dev/null)
log_debug "[$(date)] ccId: $CC_ID"
if [[ -z "$CC_ID" ]]; then
  log_debug "[$(date)] No ccId in config, exit 0 (allow stop)"
  exit 0
fi

# 处于微信模式，需要恢复轮询
# 使用 exit code 2 阻止停止，并提示 Claude 调用 MCP 工具
log_debug "[$(date)] ✅ WeChat mode active, blocking stop to resume polling"
log_debug "[$(date)] ccId=$CC_ID, will prompt Claude to call get_pending_messages"
echo "任务已完成，请调用 mcp__wecom-aibot__get_pending_messages(cc_id=\"$CC_ID\", timeout_ms=30000) 恢复微信消息轮询" >&2
exit 2
`;

  ensureConfigDir();
  fs.writeFileSync(STOP_HOOK_SCRIPT_PATH, script, { mode: 0o755 });
  console.log(`[config] Stop Hook 脚本已写入: ${STOP_HOOK_SCRIPT_PATH}`);
}

// 写入 MCP 工具权限到 Claude settings
function writeMcpPermissions() {
  try {
    // 确保目录存在
    const claudeDir = path.dirname(CLAUDE_SETTINGS_FILE);
    if (!fs.existsSync(claudeDir)) {
      fs.mkdirSync(claudeDir, { recursive: true });
    }

    // 读取现有配置
    let settings: any = {};
    if (fs.existsSync(CLAUDE_SETTINGS_FILE)) {
      const content = fs.readFileSync(CLAUDE_SETTINGS_FILE, 'utf-8');
      settings = JSON.parse(content);
    }

    // 写入 MCP 工具权限（去重）
    if (!settings.permissions) settings.permissions = { allow: [] };
    if (!settings.permissions.allow) settings.permissions.allow = [];
    const existingPerms = new Set(settings.permissions.allow);
    for (const perm of MCP_TOOL_PERMISSIONS) {
      if (!existingPerms.has(perm)) settings.permissions.allow.push(perm);
    }

    fs.writeFileSync(CLAUDE_SETTINGS_FILE, JSON.stringify(settings, null, 2));

    // 确保 hook 脚本文件存在（供项目级 hook 引用）
    writeHookScript();
  } catch (err) {
    logger.error('[config] 写入配置失败:', err);
    console.log('[config] ⚠️  请手动配置，详见 README');
  }
}

// 确保 hook 已安装（幂等，可多次调用）
export function ensureHookInstalled() {
  writeMcpPermissions();
  writeStopHookScript();
}

export type InstallMode = 'channel-only' | 'remote' | 'remote-channel';

// 读取上次安装的模式 + 远程参数（来自 version.json）
export function getInstalledMode(): { mode?: InstallMode; remote?: { url: string; token?: string } } {
  if (!fs.existsSync(VERSION_FILE)) return {};
  try {
    const data = JSON.parse(fs.readFileSync(VERSION_FILE, 'utf-8'));
    const result: { mode?: InstallMode; remote?: { url: string; token?: string } } = {};
    if (data.mode) result.mode = data.mode as InstallMode;
    if (data.remote?.url) result.remote = { url: data.remote.url, token: data.remote.token };
    return result;
  } catch {
    return {};
  }
}

// 写 version.json（统一入口，记录 mode + 远程参数，用于后续 --upgrade 复用）
function writeVersionFile(mode: InstallMode, remoteOptions?: { url: string; token?: string }) {
  const payload: any = { version: VERSION, installedAt: Date.now(), mode };
  if (remoteOptions?.url) payload.remote = { url: remoteOptions.url, ...(remoteOptions.token ? { token: remoteOptions.token } : {}) };
  fs.writeFileSync(VERSION_FILE, JSON.stringify(payload, null, 2));
}

// 确保所有全局配置已写入（强制覆盖，不依赖智能体）
export function ensureGlobalConfigs(mode: InstallMode = 'channel-only', remoteOptions?: { url: string; token: string }): { upgraded: boolean; previousVersion?: string } {
  ensureConfigDir();

  // 读取已安装版本
  let previousVersion: string | undefined;
  let upgraded = false;

  if (fs.existsSync(VERSION_FILE)) {
    const versionData = JSON.parse(fs.readFileSync(VERSION_FILE, 'utf-8'));
    previousVersion = versionData.version;
  }

  // 版本升级检测
  if (previousVersion !== VERSION) {
    upgraded = true;
    console.log(`[config] 版本升级: ${previousVersion || '未安装'} -> ${VERSION}`);
  }

  // remote 模式：仅写入远程 HTTP MCP 配置（带 token headers），不装 Channel/Hook
  if (mode === 'remote') {
    if (!remoteOptions?.url || !remoteOptions?.token) {
      console.log('[config] ❌ 远程模式需要提供 URL 和 Token');
      return { upgraded: false, previousVersion };
    }
    let claudeConfig: any = {};
    if (fs.existsSync(CLAUDE_CONFIG_FILE)) {
      claudeConfig = JSON.parse(fs.readFileSync(CLAUDE_CONFIG_FILE, 'utf-8'));
    }
    if (!claudeConfig.mcpServers) claudeConfig.mcpServers = {};
    const mcpEndpointUrl = remoteOptions.url.replace(/\/+$/, '') + '/mcp';
    claudeConfig.mcpServers['wecom-aibot'] = {
      type: 'http',
      url: mcpEndpointUrl,
      headers: { Authorization: `Bearer ${remoteOptions.token}` },
    };
    fs.writeFileSync(CLAUDE_CONFIG_FILE, JSON.stringify(claudeConfig, null, 2));
    console.log('[config] remote 模式：已写入远程 HTTP MCP 配置（带 Token）');
    writeVersionFile(mode, remoteOptions);
    return { upgraded, previousVersion };
  }

  // remote-channel 模式：远程部署的 Channel 客户端——只写 Channel MCP，不写 HTTP MCP
  if (mode === 'remote-channel') {
    if (!remoteOptions?.url) {
      console.log('[config] ❌ 远程模式需要提供 URL');
      return { upgraded: false, previousVersion };
    }
    let claudeConfig: any = {};
    if (fs.existsSync(CLAUDE_CONFIG_FILE)) {
      claudeConfig = JSON.parse(fs.readFileSync(CLAUDE_CONFIG_FILE, 'utf-8'));
    }
    if (!claudeConfig.mcpServers) claudeConfig.mcpServers = {};

    const channelEnvRemote: any = { MCP_URL: remoteOptions.url.replace(/\/+$/, '') };
    if (remoteOptions.token) channelEnvRemote.MCP_AUTH_TOKEN = remoteOptions.token;
    claudeConfig.mcpServers['wecom-aibot-channel'] = {
      command: 'npx',
      args: ['-y', '@vrs-soft/wecom-aibot-mcp', '--channel'],
      env: channelEnvRemote,
    };

    // 移除可能残留的 HTTP MCP client 配置（远程模式 HTTP/Channel 完全分离）
    if (claudeConfig.mcpServers['wecom-aibot']) {
      delete claudeConfig.mcpServers['wecom-aibot'];
      console.log('[config] 已移除残留的 HTTP MCP client 配置（远程模式只用 Channel）');
    }

    fs.writeFileSync(CLAUDE_CONFIG_FILE, JSON.stringify(claudeConfig, null, 2));
    console.log('[config] remote-channel 模式：仅写入 Channel MCP 配置');

    writeMcpPermissions();
    console.log('[config] 已写入权限配置到 ~/.claude/settings.local.json');

    writeVersionFile(mode, remoteOptions);
    return { upgraded, previousVersion };
  }

  // channel-only 模式：必须通过 MCP_URL 指定远程地址
  let claudeConfig: any = {};
  if (fs.existsSync(CLAUDE_CONFIG_FILE)) {
    const content = fs.readFileSync(CLAUDE_CONFIG_FILE, 'utf-8');
    claudeConfig = JSON.parse(content);
  }
  if (!claudeConfig.mcpServers) claudeConfig.mcpServers = {};

  const isPackageInstall = __dirname.includes('node_modules');
  const channelCmd = isPackageInstall
    ? { command: 'npx', args: ['-y', '@vrs-soft/wecom-aibot-mcp', '--channel'] }
    : { command: 'node', args: [path.join(__dirname, 'bin.js'), '--channel'] };

  const mcpUrl = process.env.MCP_URL;
  if (!mcpUrl) {
    console.log('[config] ❌ Channel-only 模式需要指定 MCP_URL');
    console.log('[config] 请设置环境变量: MCP_URL=http://远程IP:18963');
    return { upgraded: false, previousVersion };
  }
  const channelEnv: any = { MCP_URL: mcpUrl.replace(/\/+$/, '') };
  const authToken = getAuthToken();
  if (authToken) channelEnv.MCP_AUTH_TOKEN = authToken;
  claudeConfig.mcpServers['wecom-aibot-channel'] = {
    command: channelCmd.command,
    args: channelCmd.args,
    env: channelEnv,
  };
  console.log('[config] Channel-only 模式：Channel MCP 已配置');

  fs.writeFileSync(CLAUDE_CONFIG_FILE, JSON.stringify(claudeConfig, null, 2));
  console.log('[config] 已写入 MCP 配置到 ~/.claude.json');

  writeMcpPermissions();
  console.log('[config] 已写入权限配置到 ~/.claude/settings.local.json');

  writeVersionFile(mode);
  console.log(`[config] 已记录版本号: ${VERSION}`);

  return { upgraded, previousVersion };
}

// 远程安装向导（交互式输入 URL + Token）
export async function runRemoteInstallWizard(): Promise<'remote' | 'remote-channel' | null> {
  const rl = createRL();

  try {
    console.log('\n请选择连接远程服务器的方式：\n');
    console.log('  1. Channel MCP（推荐：SSE 自动推送，消息到达立即唤醒 agent）');
    console.log('  2. HTTP MCP（轮询模式，兼容不支持 Channel 的 Claude Code）\n');

    const choice = await question(rl, '请选择 (1/2): ');
    const mode = choice === '2' ? 'remote' : 'remote-channel';

    let serverUrl = await question(rl, '远程服务器地址（如 https://your-server:18963）: ');
    while (!serverUrl) {
      console.log('服务器地址不能为空');
      serverUrl = await question(rl, '远程服务器地址: ');
    }

    // 标准化 URL（去掉尾部斜杠）
    serverUrl = serverUrl.replace(/\/+$/, '');

    let token = await question(rl, 'Auth Token（必填，远程服务器需配置相同 Token）: ');
    while (!token) {
      console.log('Auth Token 不能为空');
      token = await question(rl, 'Auth Token: ');
    }

    // 写入配置
    ensureGlobalConfigs(mode, { url: serverUrl, token });

    console.log('\n─────────────────────────────────────');
    console.log('Client 配置完成！');
    console.log(`  模式:       ${mode === 'remote-channel' ? 'Channel（仅 Channel MCP）' : 'HTTP（仅 HTTP MCP）'}`);
    console.log(`  服务器:     ${serverUrl}`);
    console.log(`  Auth Token: ${token.slice(0, 8)}...${token.slice(-4)}`);
    console.log('─────────────────────────────────────\n');

    if (mode === 'remote-channel') {
      console.log('Channel 模式优势：微信消息通过 SSE 自动唤醒 agent，无需主动轮询');
      console.log('启动方式：claude --dangerously-load-development-channels server:wecom-aibot-channel');
    }

    console.log('[config] 请重启 Claude Code 以加载最新配置\n');
    return mode;
  } finally {
    rl.close();
  }
}

/**
 * 安装 headless-mode skill 到项目目录
 * 返回：{ success, skillUrl? } - 如果模板不存在，返回 HTTP endpoint URL
 */
export function installSkill(projectDir: string): { success: boolean; skillUrl?: string; message?: string } {
  const skillDir = path.join(projectDir, '.claude', 'skills', 'headless-mode');
  const skillFile = path.join(skillDir, 'SKILL.md');

  // 确保 skill 目录存在
  if (!fs.existsSync(skillDir)) {
    fs.mkdirSync(skillDir, { recursive: true });
  }

  // 检查模板文件是否存在
  if (!fs.existsSync(SKILL_TEMPLATE_FILE)) {
    console.log('[config] Skill 模板文件不存在，返回 HTTP endpoint URL');
    return {
      success: false,
      skillUrl: `${process.env.MCP_URL || 'http://127.0.0.1:18963'}/skill`,
      message: '请通过 skillUrl 下载 skill 文件并写入本地',
    };
  }

  // 写入 skill 文件
  fs.copyFileSync(SKILL_TEMPLATE_FILE, skillFile);
  console.log(`[config] 已安装 skill 到 ${skillFile}`);
  return { success: true };
}

// 创建 readline 接口
function createRL(): readline.ReadLine {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

// 提问函数
function question(rl: readline.ReadLine, prompt: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      resolve(answer.trim());
    });
  });
}
