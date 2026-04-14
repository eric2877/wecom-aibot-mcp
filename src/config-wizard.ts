/**
 * 配置向导模块
 *
 * 首次运行时引导用户配置 Bot ID、Secret 和默认目标用户
 *
 * 配置存储位置：
 * - 机器人配置：~/.wecom-aibot-mcp/config.json
 * - MCP 配置：~/.claude.json (仅 URL)
 */
import * as readline from 'readline';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { fileURLToPath } from 'url';
import { logger } from './logger.js';

export interface WecomConfig {
  botId: string;
  secret: string;
  targetUserId: string;
  targetUserName?: string;
  nameTag?: string;  // 机器人名称
  doc_mcp_url?: string;  // 机器人文档 MCP URL（企业微信文档能力）
}

const CONFIG_DIR = path.join(os.homedir(), '.wecom-aibot-mcp');
const BOT_CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const VERSION_FILE = path.join(CONFIG_DIR, 'version.json');
const CLAUDE_CONFIG_FILE = path.join(os.homedir(), '.claude.json');
const CLAUDE_SETTINGS_FILE = path.join(os.homedir(), '.claude', 'settings.local.json');
const HOOK_SCRIPT_PATH = path.join(CONFIG_DIR, 'permission-hook.sh');
const TASK_COMPLETED_HOOK_SCRIPT_PATH = path.join(CONFIG_DIR, 'task-completed-hook.sh');

// Skill 模板路径（包内）- 使用 fileURLToPath 确保跨平台兼容
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 版本号（从 package.json 读取）
const VERSION: string = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8')).version;
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

// 从 ~/.wecom-aibot-mcp/config.json 读取已保存的配置
export function loadConfig(): WecomConfig | null {
  try {
    // 从机器人配置文件读取
    if (fs.existsSync(BOT_CONFIG_FILE)) {
      const content = fs.readFileSync(BOT_CONFIG_FILE, 'utf-8');
      const config = JSON.parse(content);
      if (config.botId && config.secret && config.targetUserId) {
        const result: WecomConfig = {
          botId: config.botId,
          secret: config.secret,
          targetUserId: config.targetUserId,
        };
        if (config.nameTag) result.nameTag = config.nameTag;
        if (config.doc_mcp_url) result.doc_mcp_url = config.doc_mcp_url;
        return result;
      }
    }
  } catch (err) {
    logger.error('[config] 读取配置失败:', err);
  }
  return null;
}

// 获取所有 wecom-aibot 相关的 MCP 实例
export function listAllMcpInstances(): Array<{ name: string; config: WecomConfig }> {
  // 现在只有一个主配置文件
  const config = loadConfig();
  if (config) {
    return [{ name: 'wecom-aibot', config }];
  }
  return [];
}

// 删除配置（从 ~/.claude.json）
export function deleteConfig() {
  try {
    if (fs.existsSync(CLAUDE_CONFIG_FILE)) {
      const content = fs.readFileSync(CLAUDE_CONFIG_FILE, 'utf-8');
      const claudeConfig = JSON.parse(content);

      if (claudeConfig.mcpServers?.['wecom-aibot']) {
        delete claudeConfig.mcpServers['wecom-aibot'];
        fs.writeFileSync(CLAUDE_CONFIG_FILE, JSON.stringify(claudeConfig, null, 2));
        console.log('[config] 已从 ~/.claude.json 删除 wecom-aibot 配置');
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

      if (settings.hooks && settings.hooks['PermissionRequest']) {
        // 只删除 wecom-aibot 相关的 hook
        settings.hooks['PermissionRequest'] = settings.hooks['PermissionRequest'].filter(
          (hook: any) => !hook.hooks?.some?.((h: any) => h.command?.includes?.('wecom-aibot-mcp'))
        );
        if (settings.hooks['PermissionRequest'].length === 0) {
          delete settings.hooks['PermissionRequest'];
        }
        fs.writeFileSync(CLAUDE_SETTINGS_FILE, JSON.stringify(settings, null, 2));
        console.log('[config] 已删除 PermissionRequest hook');
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

// 删除单个机器人配置（按名称）
export function deleteRobotConfig(robotName: string): boolean {
  try {
    const robots = listAllRobots();
    const robot = robots.find(r => r.name === robotName);

    if (!robot) {
      console.log(`[config] 机器人 "${robotName}" 不存在`);
      return false;
    }

    // 查找机器人对应的配置文件
    let configFile: string | null = null;
    let isDefault = false;

    // 检查是否是默认机器人（config.json）
    if (fs.existsSync(BOT_CONFIG_FILE)) {
      const config = JSON.parse(fs.readFileSync(BOT_CONFIG_FILE, 'utf-8'));
      const name = config.nameTag || `机器人-${config.botId?.slice(0, 8) || 'unknown'}`;
      if (name === robotName) {
        configFile = BOT_CONFIG_FILE;
        isDefault = true;
      }
    }

    // 检查其他机器人配置文件
    if (!configFile && fs.existsSync(CONFIG_DIR)) {
      const files = fs.readdirSync(CONFIG_DIR).filter(f => f.startsWith('robot-') && f.endsWith('.json'));
      for (const file of files) {
        const filePath = path.join(CONFIG_DIR, file);
        const config = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        const name = config.nameTag || file.replace('.json', '');
        if (name === robotName) {
          configFile = filePath;
          break;
        }
      }
    }

    if (!configFile) {
      console.log(`[config] 未找到机器人 "${robotName}" 的配置文件`);
      return false;
    }

    // 如果是默认机器人，需要处理迁移
    if (isDefault) {
      // 查找其他机器人配置文件
      const otherRobotFiles = fs.existsSync(CONFIG_DIR)
        ? fs.readdirSync(CONFIG_DIR).filter(f => f.startsWith('robot-') && f.endsWith('.json'))
        : [];

      if (otherRobotFiles.length > 0) {
        // 将第一个其他机器人提升为默认
        const newDefaultFile = path.join(CONFIG_DIR, otherRobotFiles[0]);
        const newDefaultConfig = JSON.parse(fs.readFileSync(newDefaultFile, 'utf-8'));
        fs.writeFileSync(BOT_CONFIG_FILE, JSON.stringify(newDefaultConfig, null, 2));
        fs.unlinkSync(newDefaultFile);
        console.log(`[config] 已将 "${newDefaultConfig.nameTag || otherRobotFiles[0]}" 提升为默认机器人`);
      } else {
        // 没有其他机器人，直接删除默认配置
        fs.unlinkSync(BOT_CONFIG_FILE);
        console.log('[config] 已删除最后一个机器人配置');
      }
    } else {
      // 不是默认机器人，直接删除
      fs.unlinkSync(configFile);
    }

    console.log(`[config] 已删除机器人: ${robotName}`);
    return true;
  } catch (err) {
    logger.error('[config] 删除机器人配置失败:', err);
    return false;
  }
}

// 删除单个 MCP 配置（按实例名）- 已弃用，保留用于 --uninstall
export function deleteMcpConfig(instanceName: string): boolean {
  try {
    if (!fs.existsSync(CLAUDE_CONFIG_FILE)) {
      console.log('[config] ~/.claude.json 不存在');
      return false;
    }

    const content = fs.readFileSync(CLAUDE_CONFIG_FILE, 'utf-8');
    const claudeConfig = JSON.parse(content);

    if (!claudeConfig.mcpServers?.[instanceName]) {
      console.log(`[config] 实例 "${instanceName}" 不存在`);
      return false;
    }

    // 检查是否是 wecom-aibot 相关配置
    const serverConfig = claudeConfig.mcpServers[instanceName];
    if (!serverConfig?.env?.WECOM_BOT_ID) {
      console.log(`[config] "${instanceName}" 不是企业微信机器人配置`);
      return false;
    }

    delete claudeConfig.mcpServers[instanceName];
    fs.writeFileSync(CLAUDE_CONFIG_FILE, JSON.stringify(claudeConfig, null, 2));
    console.log(`[config] 已删除实例: ${instanceName}`);
    return true;
  } catch (err) {
    logger.error('[config] 删除配置失败:', err);
    return false;
  }
}

// 交互式删除机器人配置
export async function deleteRobotConfigInteractive(robotName?: string): Promise<void> {
  const robots = listAllRobots();

  if (robots.length === 0) {
    console.log('[config] 没有找到任何企业微信机器人配置');
    return;
  }

  // 始终显示列表
  console.log('\n企业微信机器人配置列表：\n');
  robots.forEach((robot, idx) => {
    const isDefault = idx === 0;
    const defaultTag = isDefault ? ' [默认]' : '';
    console.log(`  ${idx + 1}. ${robot.name}${defaultTag} (Bot ID: ${robot.botId.slice(0, 12)}..., 用户: ${robot.targetUserId})`);
  });

  // 如果提供了机器人名称，验证并删除
  if (robotName) {
    const found = robots.find(r => r.name === robotName);
    if (!found) {
      console.log(`\n[config] 未找到名为 "${robotName}" 的机器人`);
      return;
    }
    console.log(`\n[config] 将删除机器人: ${robotName}`);
    deleteRobotConfig(robotName);
    return;
  }

  // 没有提供名称，让用户选择
  console.log(`  0. 取消\n`);

  const rl = createRL();
  try {
    const choice = await question(rl, '请选择要删除的机器人序号: ');
    const choiceNum = parseInt(choice);

    if (choiceNum === 0) {
      console.log('[config] 已取消');
      return;
    }

    if (choiceNum < 1 || choiceNum > robots.length) {
      console.log('[config] 无效选择');
      return;
    }

    const selected = robots[choiceNum - 1];
    const confirm = await question(rl, `确认删除机器人 "${selected.name}"？(y/N): `);

    if (confirm.toLowerCase() === 'y') {
      deleteRobotConfig(selected.name);
      console.log(`[config] MCP 配置保留，其他机器人仍可正常使用\n`);
    } else {
      console.log('[config] 已取消');
    }
  } finally {
    rl.close();
  }
}

// 交互式删除 MCP 配置（已弃用，保留用于兼容）
export async function deleteMcpConfigInteractive(instanceName?: string): Promise<void> {
  // 转换为删除机器人配置
  await deleteRobotConfigInteractive(instanceName);
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

  // 删除整个配置目录（包括 config.json、robot-*.json、hook 脚本、日志等）
  // 使用 recursive: true 和 force: true 确保完全删除
  if (fs.existsSync(CONFIG_DIR)) {
    try {
      // 先删除所有文件，再删除目录（防止文件被重建）
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
      // 最后尝试删除目录本身
      try {
        fs.rmSync(CONFIG_DIR, { recursive: true, force: true });
        console.log('[config] 已删除配置目录');
      } catch {
        // 目录可能被其他进程占用，下次启动时会清理
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
# 检查 $(pwd)/.claude/wecom-aibot.json 的 wechatMode 和 autoApprove 字段

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

# 检查项目目录的微信模式配置文件
PROJECT_DIR=$(pwd)
CONFIG_FILE="$PROJECT_DIR/.claude/wecom-aibot.json"

log_debug "[$(date)] Checking config: $CONFIG_FILE"

# 配置文件不存在，不在微信模式
if [[ ! -f "$CONFIG_FILE" ]]; then
  log_debug "[$(date)] No config file, exit 0"
  exit 0
fi

# 检查 wechatMode 是否为 true（微信模式开关）
WECHAT_MODE=$(jq -r '.wechatMode // false' "$CONFIG_FILE" 2>/dev/null)
log_debug "[$(date)] wechatMode: $WECHAT_MODE"
if [[ "$WECHAT_MODE" != "true" ]]; then
  log_debug "[$(date)] wechatMode not true, exit 0"
  exit 0
fi

# 检查 MCP Server 是否在线
HEALTH=$(curl -s -m 2 "http://127.0.0.1:$MCP_PORT/health" 2>/dev/null)
log_debug "[$(date)] Health check: $HEALTH"
if ! echo "$HEALTH" | jq -e '.status == "ok"' > /dev/null 2>&1; then
  log_debug "[$(date)] Health check failed, exit 0"
  exit 0
fi

# 读取当前项目使用的机器人名称
ROBOT_NAME=$(jq -r '.robotName // empty' "$CONFIG_FILE" 2>/dev/null)

# 发送审批请求（使用 pwd 作为 projectDir）
TOOL_INPUT=$(echo "$INPUT" | jq -c '.tool_input // {}')
BODY=$(jq -n --arg tool_name "$TOOL_NAME" --argjson tool_input "$TOOL_INPUT" --arg project_dir "$PROJECT_DIR" --arg robot_name "$ROBOT_NAME" \\
  '{"tool_name":$tool_name,"tool_input":$tool_input,"projectDir":$project_dir,"robotName":$robot_name}')

log_debug "[$(date)] Sending approval request..."
RESPONSE=$(curl -s -m 10 -X POST "http://127.0.0.1:$MCP_PORT/approve" \\
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
AUTO_APPROVE_TIMEOUT=$(jq -r '.autoApproveTimeout // 600' "$CONFIG_FILE" 2>/dev/null)
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

  STATUS=$(curl -s -m 3 "http://127.0.0.1:$MCP_PORT/approval_status/$TASK_ID" 2>/dev/null)
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

log_debug "[$(date)] Timeout reached, checking autoApprove setting"

# 超时处理：根据 autoApprove 决定行为
# autoApprove: false → 继续等待（无限轮询）
# autoApprove: true → 智能代批

AUTO_APPROVE=$(jq -r '.autoApprove // false' "$CONFIG_FILE" 2>/dev/null)
log_debug "[$(date)] autoApprove: $AUTO_APPROVE"
if [[ "$AUTO_APPROVE" != "true" ]]; then
  log_debug "[$(date)] autoApprove off, entering infinite wait"
  # autoApprove 关闭，继续无限等待用户响应
  while true; do
    sleep 2
    STATUS=$(curl -s -m 3 "http://127.0.0.1:$MCP_PORT/approval_status/$TASK_ID" 2>/dev/null)
    RESULT=$(echo "$STATUS" | jq -r '.result // empty')

    if [[ "$RESULT" == "allow-once" || "$RESULT" == "allow-always" ]]; then
      log_debug "[$(date)] Approved by user (infinite wait)"
      printf '%s\\n' '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
      exit 0
    elif [[ "$RESULT" == "deny" ]]; then
      log_debug "[$(date)] Denied by user (infinite wait)"
      printf '%s\\n' '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"用户拒绝"}}}'
      exit 0
    fi
  done
fi

# autoApprove: true，执行智能代批
# 规则：删除命令→拒绝，项目内操作→允许，项目外操作→拒绝
log_debug "[$(date)] Executing smart auto-approval"

# 检查是否是删除命令
IS_DELETE=0
if [[ "$TOOL_NAME" == "Bash" ]]; then
  CMD=$(echo "$TOOL_INPUT" | jq -r '.command // empty')
  log_debug "[$(date)] Checking delete: CMD=$CMD"
  if [[ "$CMD" == rm* ]] || [[ "$CMD" == *" rm "* ]] || [[ "$CMD" == *"-rf"* ]]; then
    IS_DELETE=1
  fi
fi

log_debug "[$(date)] IS_DELETE: $IS_DELETE"

# 删除操作 → 永远拒绝
if [[ $IS_DELETE -eq 1 ]]; then
  log_debug "[$(date)] Auto-deny: delete operation"
  # 通知 MCP Server 发送微信消息
  curl -s -m 5 -X POST "http://127.0.0.1:$MCP_PORT/approval_timeout/$TASK_ID" -H "Content-Type: application/json" -d '{"result":"deny","reason":"超时自动拒绝：删除操作需人工确认"}' > /dev/null 2>&1 &
  printf '%s\\n' '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"超时自动拒绝：删除操作需人工确认"}}}'
  exit 0
fi

# 检查操作路径是否在项目内
IS_IN_PROJECT=0

case "$TOOL_NAME" in
  Bash)
    CMD=$(echo "$TOOL_INPUT" | jq -r '.command // empty')
    # 只有明确在项目目录内操作才认为是项目内操作
    # 相对路径 ./ 或包含项目目录路径
    if [[ "$CMD" == *"$PROJECT_DIR"* ]] || [[ "$CMD" == ./* ]]; then
      IS_IN_PROJECT=1
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
  curl -s -m 5 -X POST "http://127.0.0.1:$MCP_PORT/approval_timeout/$TASK_ID" -H "Content-Type: application/json" -d '{"result":"allow-once","reason":"超时自动允许：项目内操作"}' > /dev/null 2>&1 &
  printf '%s\\n' '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow","message":"超时自动允许：项目内操作"}}}'
else
  log_debug "[$(date)] Auto-deny: outside project"
  # 通知 MCP Server 发送微信消息
  curl -s -m 5 -X POST "http://127.0.0.1:$MCP_PORT/approval_timeout/$TASK_ID" -H "Content-Type: application/json" -d '{"result":"deny","reason":"超时自动拒绝：项目外操作需人工确认"}' > /dev/null 2>&1 &
  printf '%s\\n' '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"超时自动拒绝：项目外操作需人工确认"}}}'
fi
`;

  ensureConfigDir();
  fs.writeFileSync(HOOK_SCRIPT_PATH, script, { mode: 0o755 });
  console.log(`[config] Hook 脚本已写入: ${HOOK_SCRIPT_PATH}`);
}

// 生成并写入 TaskCompleted hook 脚本
// 用于任务完成后自动恢复微信消息轮询
function writeTaskCompletedHookScript() {
  const script = `#!/bin/bash
# wecom-aibot-mcp TaskCompleted hook
# 任务完成后检查是否需要恢复微信消息轮询
#
# 固定端口: 18963
# 检查 $(pwd)/.claude/wecom-aibot.json 的 wechatMode 和 autoApprove 字段

MCP_PORT=18963

# 先保存输入（TaskCompleted 事件数据）
INPUT=$(cat)

# 日志输出：--debug 模式下输出到 stderr，否则静默
DEBUG_FILE="$HOME/.wecom-aibot-mcp/debug"
log_debug() {
  if [[ -f "$DEBUG_FILE" ]]; then
    echo "$1" >&2
  fi
}

log_debug "[$(date)] TaskCompleted hook called. INPUT: \${INPUT:0:200}"

# 检查项目目录的微信模式配置文件
PROJECT_DIR=$(pwd)
CONFIG_FILE="$PROJECT_DIR/.claude/wecom-aibot.json"

log_debug "[$(date)] Checking config: $CONFIG_FILE"

# 配置文件不存在，不在微信模式
if [[ ! -f "$CONFIG_FILE" ]]; then
  log_debug "[$(date)] No config file, exit 0 (allow complete)"
  exit 0
fi

# 检查 wechatMode 是否为 true（微信模式开关）
WECHAT_MODE=$(jq -r '.wechatMode // false' "$CONFIG_FILE" 2>/dev/null)
log_debug "[$(date)] wechatMode: $WECHAT_MODE"
if [[ "$WECHAT_MODE" != "true" ]]; then
  log_debug "[$(date)] wechatMode not true, exit 0 (allow complete)"
  exit 0
fi

# 检查 autoApprove 是否为 true（需要恢复轮询的模式）
AUTO_APPROVE=$(jq -r '.autoApprove // false' "$CONFIG_FILE" 2>/dev/null)
log_debug "[$(date)] autoApprove: $AUTO_APPROVE"
if [[ "$AUTO_APPROVE" != "true" ]]; then
  log_debug "[$(date)] autoApprove not true, exit 0 (allow complete)"
  exit 0
fi

# 检查 MCP Server 是否在线
HEALTH=$(curl -s -m 2 "http://127.0.0.1:$MCP_PORT/health" 2>/dev/null)
log_debug "[$(date)] Health check: $HEALTH"
if ! echo "$HEALTH" | jq -e '.status == "ok"' > /dev/null 2>&1; then
  log_debug "[$(date)] MCP Server offline, exit 0 (allow complete)"
  exit 0
fi

# 获取 ccId
CC_ID=$(jq -r '.ccId // empty' "$CONFIG_FILE" 2>/dev/null)
log_debug "[$(date)] ccId: $CC_ID"
if [[ -z "$CC_ID" ]]; then
  log_debug "[$(date)] No ccId in config, exit 0 (allow complete)"
  exit 0
fi

# 处于微信模式且 autoApprove 为 true，需要恢复轮询
# 使用 exit code 2 阻止任务完成，并提示 Claude 调用 MCP 工具
log_debug "[$(date)] ✅ WeChat mode active, blocking completion to resume polling"
log_debug "[$(date)] ccId=$CC_ID, will prompt Claude to call get_pending_messages"
echo "任务已完成，请调用 mcp__wecom-aibot__get_pending_messages(cc_id=\"$CC_ID\", timeout_ms=30000) 恢复微信消息轮询" >&2
exit 2
`;

  ensureConfigDir();
  fs.writeFileSync(TASK_COMPLETED_HOOK_SCRIPT_PATH, script, { mode: 0o755 });
  console.log(`[config] TaskCompleted Hook 脚本已写入: ${TASK_COMPLETED_HOOK_SCRIPT_PATH}`);
}

// 写入 MCP Server 配置到 ~/.claude.json
function writeMcpServerConfig(config: WecomConfig, instanceName?: string) {
  try {
    ensureConfigDir();

    // 构建机器人配置对象
    const botConfig: any = {
      botId: config.botId,
      secret: config.secret,
      targetUserId: config.targetUserId,
    };
    if (config.nameTag) {
      botConfig.nameTag = config.nameTag;
    }
    if (config.doc_mcp_url) {
      botConfig.doc_mcp_url = config.doc_mcp_url;
    }

    // 检查名称唯一性（如果设置了新名称）
    if (config.nameTag && isRobotNameExists(config.nameTag, config.botId)) {
      console.log(`[config] ❌ 机器人名称 "${config.nameTag}" 已被其他机器人使用`);
      console.log('[config] 请使用不同的名称');
      return false;
    }

    // 按 botId 查找现有配置文件
    const existingConfigFile = findRobotConfigFileByBotId(config.botId);

    if (existingConfigFile) {
      // 更新现有配置文件
      fs.writeFileSync(existingConfigFile, JSON.stringify(botConfig, null, 2));
      console.log(`[config] 已更新机器人配置: ${existingConfigFile}`);
    } else {
      // 新配置：检查是否有默认配置文件
      if (fs.existsSync(BOT_CONFIG_FILE)) {
        // 有默认配置，创建新的 robot-*.json 文件
        const newConfigPath = path.join(CONFIG_DIR, `robot-${Date.now()}.json`);
        fs.writeFileSync(newConfigPath, JSON.stringify(botConfig, null, 2));
        console.log(`[config] 已添加新机器人配置: ${newConfigPath}`);
      } else {
        // 没有默认配置，写入 config.json
        fs.writeFileSync(BOT_CONFIG_FILE, JSON.stringify(botConfig, null, 2));
        console.log('[config] 已写入机器人配置 ~/.wecom-aibot-mcp/config.json');
      }
    }

    // 2. 写入 MCP 配置到 ~/.claude.json（仅 URL）
    let claudeConfig: any = {};
    if (fs.existsSync(CLAUDE_CONFIG_FILE)) {
      const content = fs.readFileSync(CLAUDE_CONFIG_FILE, 'utf-8');
      claudeConfig = JSON.parse(content);
    }

    if (!claudeConfig.mcpServers) claudeConfig.mcpServers = {};

    const name = instanceName || 'wecom-aibot';

    // HTTP Transport 配置格式
    claudeConfig.mcpServers[name] = {
      type: 'http',
      url: 'http://127.0.0.1:18963/mcp',
    };

    fs.writeFileSync(CLAUDE_CONFIG_FILE, JSON.stringify(claudeConfig, null, 2));
    console.log(`[config] MCP 配置已写入 ~/.claude.json (实例名: ${name})`);
    return true;
  } catch (err) {
    logger.error('[config] 写入配置失败:', err);
    console.log('[config] ⚠️  请手动配置:');
    console.log('');
    console.log('~/.wecom-aibot-mcp/config.json:');
    console.log(JSON.stringify({
      botId: config.botId,
      secret: config.secret,
      targetUserId: config.targetUserId,
    }, null, 2));
    console.log('');
    console.log('~/.claude.json:');
    console.log(JSON.stringify({
      mcpServers: {
        'wecom-aibot': {
          type: 'http',
          url: 'http://127.0.0.1:18963/mcp',
        },
      },
    }, null, 2));
    return false;
  }
}

// 添加新的机器人配置（多机器人场景）
export async function addMcpConfig() {
  const rl = createRL();

  try {
    console.log('\n添加新的企业微信机器人配置\n');
    console.log('提示：多个机器人共享同一个 MCP 配置，只需添加机器人凭证即可\n');

    // 获取机器人名称（用于识别）
    const robotName = await question(rl, '机器人名称（如"张三的机器人"）: ');
    if (!robotName) {
      console.log('[config] 机器人名称不能为空');
      rl.close();
      return;
    }

    // 获取 Bot ID
    let botId = await question(rl, 'Bot ID: ');
    while (!botId) {
      console.log('Bot ID 不能为空');
      botId = await question(rl, 'Bot ID: ');
    }

    // 获取 Secret
    let secret = await question(rl, 'Secret: ');
    while (!secret) {
      console.log('Secret 不能为空');
      secret = await question(rl, 'Secret: ');
    }

    rl.close();

    // 检查是否已存在相同 botId 的配置
    const existingRobots = listAllRobots();
    const duplicate = existingRobots.find(r => r.botId === botId);

    if (duplicate) {
      console.log(`\n[config] ⚠️ 机器人已存在！`);
      console.log(`[config] 已配置的机器人: ${duplicate.name} (Bot ID: ${duplicate.botId.slice(0, 12)}...)`);
      console.log(`[config] 如需更新配置，请使用 --config 命令`);
      return;
    }

    // 检查名称是否重复（阻止）
    const duplicateName = existingRobots.find(r => r.name === robotName);
    if (duplicateName) {
      console.log(`\n[config] ❌ 名称 "${robotName}" 已被使用`);
      console.log(`[config] 请使用不同的名称以方便识别`);
      console.log(`[config] 当前已配置的机器人:`);
      existingRobots.forEach((r, i) => {
        console.log(`  ${i + 1}. ${r.name}`);
      });
      return;
    }

    // 先连接验证凭证
    console.log('\n[config] 正在连接企业微信...');
    const { initClient } = await import('./client.js');
    const client = initClient(botId, secret, 'placeholder', 'config-validation');

    // 等待连接（最多10秒）
    const connected = await new Promise<boolean>((resolve) => {
      const startTime = Date.now();
      const checkInterval = setInterval(() => {
        if (client.isConnected()) {
          clearInterval(checkInterval);
          resolve(true);
        } else if (Date.now() - startTime > 10000) {
          clearInterval(checkInterval);
          resolve(false);
        }
      }, 500);
    });

    if (!connected) {
      console.log('\n[config] ❌ 连接失败，请检查 Bot ID 和 Secret 是否正确');
      console.log('[config] 新建机器人需要等待约 2 分钟同步时间');
      console.log('[config] 如需授权，请访问企业微信管理后台完成授权');
      return;
    }

    // 通过消息自动识别用户 ID
    const targetUserId = await detectUserIdFromMessage(client, 180);

    if (!targetUserId) {
      console.log('\n[config] 未能在规定时间内识别用户 ID');
      console.log('[config] 请重新运行: npx @vrs-soft/wecom-aibot-mcp --add');
      return;
    }

    // 保存机器人配置
    const robotConfig: any = {
      botId,
      secret,
      targetUserId,
      nameTag: robotName,
    };

    // 确保配置目录存在
    ensureConfigDir();

    // 如果是第一个机器人，保存为默认配置
    const defaultConfigPath = BOT_CONFIG_FILE;
    const robotConfigPath = path.join(CONFIG_DIR, `robot-${Date.now()}.json`);

    if (!fs.existsSync(defaultConfigPath)) {
      // 第一个机器人作为默认
      fs.writeFileSync(defaultConfigPath, JSON.stringify(robotConfig, null, 2));
      console.log(`\n[config] ✅ 已设为默认机器人: ${robotName}`);
    } else {
      // 后续机器人保存为独立文件
      fs.writeFileSync(robotConfigPath, JSON.stringify(robotConfig, null, 2));
      console.log(`\n[config] ✅ 已添加新机器人: ${robotName}`);
    }

    console.log(`[config] 用户 ID: ${targetUserId}`);

    // 列出所有机器人
    const robots = listAllRobots();
    console.log(`\n[config] 当前共 ${robots.length} 个机器人配置`);
    robots.forEach((r, i) => {
      console.log(`  ${i + 1}. ${r.name} (${r.targetUserId})`);
    });

    console.log('\n[config] MCP 配置无需修改，多个机器人共享同一个 HTTP 服务');

  } catch (err) {
    logger.error('[config] 添加配置失败:', err);
    rl.close();
  }
}

// 列出所有机器人配置
export function listAllRobots(): Array<{ name: string; botId: string; targetUserId: string; doc_mcp_url?: string }> {
  const robots: Array<{ name: string; botId: string; targetUserId: string; doc_mcp_url?: string }> = [];

  // 主配置文件（config.json）
  if (fs.existsSync(BOT_CONFIG_FILE)) {
    try {
      const config = JSON.parse(fs.readFileSync(BOT_CONFIG_FILE, 'utf-8'));
      const name = config.nameTag || `机器人-${config.botId?.slice(0, 8) || 'unknown'}`;
      robots.push({
        name,
        botId: config.botId,
        targetUserId: config.targetUserId,
        ...(config.doc_mcp_url ? { doc_mcp_url: config.doc_mcp_url } : {}),
      });
    } catch {
      // ignore
    }
  }

  // 其他机器人配置
  if (fs.existsSync(CONFIG_DIR)) {
    const files = fs.readdirSync(CONFIG_DIR).filter(f => f.startsWith('robot-') && f.endsWith('.json'));
    for (const file of files) {
      try {
        const config = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, file), 'utf-8'));
        const name = config.nameTag || file.replace('.json', '');
        robots.push({
          name,
          botId: config.botId,
          targetUserId: config.targetUserId,
          ...(config.doc_mcp_url ? { doc_mcp_url: config.doc_mcp_url } : {}),
        });
      } catch {
        // ignore
      }
    }
  }

  return robots;
}

// 获取指定机器人（或唯一机器人）的文档 MCP URL
export function getDocMcpUrl(robotName?: string): { url: string | null; error?: string } {
  const robots = listAllRobots();
  const robotsWithDoc = robots.filter(r => r.doc_mcp_url);

  if (robotsWithDoc.length === 0) {
    return {
      url: null,
      error: '未配置文档 MCP URL。请运行 `npx @vrs-soft/wecom-aibot-mcp --add` 添加机器人时填写文档 MCP URL，或通过 `add_robot_config` 工具设置。',
    };
  }

  if (robotName) {
    const robot = robotsWithDoc.find(r => r.name === robotName);
    if (!robot) {
      return {
        url: null,
        error: `未找到名为 "${robotName}" 的机器人，或该机器人未配置文档 MCP URL。已配置文档能力的机器人: ${robotsWithDoc.map(r => r.name).join(', ')}`,
      };
    }
    return { url: robot.doc_mcp_url! };
  }

  if (robotsWithDoc.length === 1) {
    return { url: robotsWithDoc[0].doc_mcp_url! };
  }

  // 多个机器人有 doc_mcp_url，需要用户指定
  return {
    url: null,
    error: `有多个机器人配置了文档 MCP URL，请通过 robot_name 参数指定使用哪个机器人。已配置文档能力的机器人: ${robotsWithDoc.map(r => r.name).join(', ')}`,
  };
}

// 写入 MCP 工具权限 + 注册 PermissionRequest hook 到 Claude settings
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

    // 删除全局 PermissionRequest hook（hook 由 enter_headless_mode 写入项目级别）
    if (settings.hooks && settings.hooks['PermissionRequest']) {
      // 只删除 wecom-aibot 相关的 hook
      settings.hooks['PermissionRequest'] = settings.hooks['PermissionRequest'].filter(
        (hook: any) => !hook.hooks?.some?.((h: any) => h.command?.includes?.('wecom-aibot-mcp'))
      );
      if (settings.hooks['PermissionRequest'].length === 0) {
        delete settings.hooks['PermissionRequest'];
      }
      if (Object.keys(settings.hooks).length === 0) {
        delete settings.hooks;
      }
    }

    fs.writeFileSync(CLAUDE_SETTINGS_FILE, JSON.stringify(settings, null, 2));

    // 确保 hook 脚本文件存在（进入微信模式时需要）
    writeHookScript();
  } catch (err) {
    logger.error('[config] 写入配置失败:', err);
    console.log('[config] ⚠️  请手动配置，详见 README');
  }
}

// 确保 hook 已安装（幂等，可多次调用）
export function ensureHookInstalled() {
  writeMcpPermissions();
  writeTaskCompletedHookScript();
}

// 确保所有全局配置已写入（强制覆盖，不依赖智能体）
export function ensureGlobalConfigs(mode: 'full' | 'http-only' | 'channel-only' = 'full'): { upgraded: boolean; previousVersion?: string } {
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

  // http-only 模式：不写入 MCP 配置（远程部署场景）
  if (mode === 'http-only') {
    console.log('[config] HTTP-only 模式：跳过 MCP 配置写入');
    // 只写权限配置和 Hook（可选，用于本地调试）
    writeMcpPermissions();
    console.log('[config] 已写入权限配置到 ~/.claude/settings.local.json');
    fs.writeFileSync(VERSION_FILE, JSON.stringify({ version: VERSION, installedAt: Date.now() }, null, 2));
    return { upgraded, previousVersion };
  }

  // 1. 强制写入 MCP 配置到 ~/.claude.json
  let claudeConfig: any = {};
  if (fs.existsSync(CLAUDE_CONFIG_FILE)) {
    const content = fs.readFileSync(CLAUDE_CONFIG_FILE, 'utf-8');
    claudeConfig = JSON.parse(content);
  }

  if (!claudeConfig.mcpServers) claudeConfig.mcpServers = {};

  if (mode === 'channel-only') {
    // Channel-only 模式：必须通过 MCP_URL 指定远程地址
    const mcpUrl = process.env.MCP_URL;
    if (!mcpUrl) {
      console.log('[config] ❌ Channel-only 模式需要指定 MCP_URL');
      console.log('[config] 请设置环境变量: MCP_URL=http://远程IP:18963');
      return { upgraded: false, previousVersion };
    }
    // Channel MCP 配置：硬编码本地路径
    claudeConfig.mcpServers['wecom-aibot-channel'] = {
      command: 'node',
      args: ['/Volumes/Mac_Data/VScode/wecom-aibot-mcp/dist/bin.js', '--channel'],
      env: { MCP_URL: mcpUrl },
    };
    console.log(`[config] Channel-only 模式：Channel MCP 使用本地路径`);
  } else {
    // full 模式：同时写入 HTTP MCP 和 Channel MCP 配置
    claudeConfig.mcpServers['wecom-aibot'] = {
      type: 'http',
      url: 'http://127.0.0.1:18963/mcp',
    };
    // Channel MCP 配置：硬编码本地路径
    claudeConfig.mcpServers['wecom-aibot-channel'] = {
      command: 'node',
      args: ['/Volumes/Mac_Data/VScode/wecom-aibot-mcp/dist/bin.js', '--channel'],
      env: { MCP_URL: 'http://127.0.0.1:18963' },
    };
    console.log(`[config] full 模式：Channel MCP 使用本地路径`);
  }
  fs.writeFileSync(CLAUDE_CONFIG_FILE, JSON.stringify(claudeConfig, null, 2));
  console.log('[config] 已写入 MCP 配置到 ~/.claude.json');

  // 2. 强制写入权限配置和 Hook
  writeMcpPermissions();
  console.log('[config] 已写入权限配置到 ~/.claude/settings.local.json');

  // 3. 写入版本号
  fs.writeFileSync(VERSION_FILE, JSON.stringify({ version: VERSION, installedAt: Date.now() }, null, 2));
  console.log(`[config] 已记录版本号: ${VERSION}`);

  return { upgraded, previousVersion };
}

// 保存配置（直接写入 ~/.claude.json）
export function saveConfig(config: WecomConfig, instanceName?: string): boolean {
  ensureConfigDir();  // 确保运行时文件目录存在

  // 写入 MCP Server 配置到 ~/.claude.json
  const success = writeMcpServerConfig(config, instanceName);
  if (!success) {
    return false;
  }

  // 写入 MCP 工具权限和 Hook 到 ~/.claude/settings.local.json
  writeMcpPermissions();

  // 安装 skill 到项目目录（项目级别，支持远程部署）
  installSkill(process.cwd());

  return true;
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
    // 返回 HTTP endpoint URL，让 agent 通过 WebFetch 下载
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

// 获取用户列表（通过企业微信 API）
async function fetchUserList(botId: string, secret: string): Promise<Array<{ userid: string; name: string }>> {
  console.log('[config] 正在获取用户列表...');

  // 使用 WebSocket 获取用户列表
  // 注意：智能机器人 API 可能没有直接获取用户列表的接口
  // 我们需要通过其他方式获取，比如让用户输入或从消息记录中推断

  // 暂时返回空列表，让用户手动输入
  return [];
}

/**
 * 运行配置向导
 */
export async function runConfigWizard(): Promise<{ config: WecomConfig; instanceName: string }> {
  console.log('\n');
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║     企业微信智能机器人 MCP 服务 - 配置向导                  ║');
  console.log('╚════════════════════════════════════════════════════════════╝');

  const rl = createRL();

  try {
    const robots = listAllRobots();
    let targetRobot: { name: string; botId: string; targetUserId: string; doc_mcp_url?: string } | null = null;
    let isNewRobot = false;

    // 第一步：选择要修改的机器人
    if (robots.length === 0) {
      console.log('\n首次配置，将创建新机器人\n');
      isNewRobot = true;
    } else {
      console.log('\n请选择要操作的机器人：\n');
      robots.forEach((robot, idx) => {
        console.log(`  ${idx + 1}. ${robot.name} (Bot ID: ${robot.botId.slice(0, 12)}...)`);
      });
      console.log(`  ${robots.length + 1}. 添加新机器人\n`);

      const choice = await question(rl, '请输入序号: ');
      const choiceNum = parseInt(choice);

      if (choiceNum >= 1 && choiceNum <= robots.length) {
        targetRobot = robots[choiceNum - 1];
        console.log(`\n已选择修改: ${targetRobot.name}\n`);
      } else if (choiceNum === robots.length + 1) {
        isNewRobot = true;
        console.log('\n将创建新机器人\n');
      } else {
        console.log('[config] 无效选择');
        process.exit(1);
      }
    }

    // 第二步：输入机器人名称
    let robotName = await question(rl, `机器人名称（${targetRobot ? `当前: ${targetRobot.name}` : '用于识别'}）: `);
    if (!robotName) {
      if (targetRobot) {
        robotName = targetRobot.name;  // 保持原名称
        console.log(`[config] 保持原名称: ${robotName}`);
      } else {
        console.log('[config] 机器人名称不能为空');
        process.exit(1);
      }
    }

    // 检查名称是否与其他机器人重复
    if (isNewRobot || (targetRobot && robotName !== targetRobot.name)) {
      const duplicateName = robots.find(r => r.name === robotName && r !== targetRobot);
      if (duplicateName) {
        console.log(`[config] ❌ 名称 "${robotName}" 已被使用`);
        process.exit(1);
      }
    }

    // 第三步：输入 Bot ID
    let botId = await question(rl, `Bot ID（${targetRobot ? `当前: ${targetRobot.botId.slice(0, 12)}...` : '必填'}）: `);
    if (!botId) {
      if (targetRobot) {
        botId = targetRobot.botId;  // 保持原 Bot ID
        console.log(`[config] 保持原 Bot ID`);
      } else {
        console.log('Bot ID 不能为空');
        botId = await question(rl, 'Bot ID: ');
        if (!botId) {
          console.log('[config] Bot ID 不能为空');
          process.exit(1);
        }
      }
    }

    // 第四步：输入 Secret
    let secret = await question(rl, `Secret（${targetRobot ? `当前: ${targetRobot.botId.slice(0, 8)}...` : '必填'}）: `);
    if (!secret) {
      if (targetRobot) {
        // 读取原 Secret
        const configFile = findRobotConfigFile(targetRobot.name);
        if (configFile) {
          const config = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
          secret = config.secret;
          console.log(`[config] 保持原 Secret`);
        }
      } else {
        console.log('Secret 不能为空');
        secret = await question(rl, 'Secret: ');
        if (!secret) {
          console.log('[config] Secret 不能为空');
          process.exit(1);
        }
      }
    }

    // 第五步：文档 MCP URL（可选）
    const currentDocUrl = targetRobot?.doc_mcp_url ?? '';
    const docUrlPrompt = currentDocUrl
      ? `文档 MCP URL（当前: ${currentDocUrl.slice(0, 40)}...，留空保持不变）: `
      : '文档 MCP URL（可选，企业微信管理后台获取，留空跳过）: ';
    let docMcpUrl = await question(rl, docUrlPrompt);
    if (!docMcpUrl && currentDocUrl) {
      docMcpUrl = currentDocUrl;
      console.log('[config] 保持原文档 MCP URL');
    }

    // 第六步：目标用户（稍后通过消息自动识别）
    console.log('\n─────────────────────────────────────');
    console.log('配置确认：');
    console.log(`  机器人名称: ${robotName}`);
    console.log(`  Bot ID:     ${botId}`);
    console.log(`  Secret:     ${secret.slice(0, 8)}...${secret.slice(-4)}`);
    console.log(`  文档 MCP:   ${docMcpUrl ? '✅ 已配置' : '（未配置）'}`);
    console.log(`  目标用户:   （将通过消息自动识别）`);
    console.log('─────────────────────────────────────\n');

    const confirm = await question(rl, '确认配置？(Y/n): ');

    if (confirm.toLowerCase() === 'n') {
      console.log('[config] 配置已取消');
      process.exit(0);
    }

    // 返回临时配置（targetUserId 稍后填充）
    const config: WecomConfig = {
      botId,
      secret,
      targetUserId: '',  // 稍后通过消息识别
      nameTag: robotName,
      ...(docMcpUrl ? { doc_mcp_url: docMcpUrl } : {}),
    };

    // 如果是修改现有机器人，返回其 instanceName（用于删除旧配置）
    const instanceName = targetRobot ? targetRobot.name : 'wecom-aibot';

    return { config, instanceName };

  } finally {
    rl.close();
  }
}

// 查找机器人配置文件路径（按名称）
export function findRobotConfigFile(robotName: string): string | null {
  // 检查默认配置文件
  if (fs.existsSync(BOT_CONFIG_FILE)) {
    const config = JSON.parse(fs.readFileSync(BOT_CONFIG_FILE, 'utf-8'));
    const name = config.nameTag || `机器人-${config.botId?.slice(0, 8) || 'unknown'}`;
    if (name === robotName) {
      return BOT_CONFIG_FILE;
    }
  }

  // 检查其他机器人配置文件
  if (fs.existsSync(CONFIG_DIR)) {
    const files = fs.readdirSync(CONFIG_DIR).filter(f => f.startsWith('robot-') && f.endsWith('.json'));
    for (const file of files) {
      const filePath = path.join(CONFIG_DIR, file);
      const config = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      const name = config.nameTag || file.replace('.json', '');
      if (name === robotName) {
        return filePath;
      }
    }
  }

  return null;
}

// 查找机器人配置文件路径（按 botId）
export function findRobotConfigFileByBotId(botId: string): string | null {
  // 检查默认配置文件
  if (fs.existsSync(BOT_CONFIG_FILE)) {
    const config = JSON.parse(fs.readFileSync(BOT_CONFIG_FILE, 'utf-8'));
    if (config.botId === botId) {
      return BOT_CONFIG_FILE;
    }
  }

  // 检查其他机器人配置文件
  if (fs.existsSync(CONFIG_DIR)) {
    const files = fs.readdirSync(CONFIG_DIR).filter(f => f.startsWith('robot-') && f.endsWith('.json'));
    for (const file of files) {
      const filePath = path.join(CONFIG_DIR, file);
      const config = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      if (config.botId === botId) {
        return filePath;
      }
    }
  }

  return null;
}

// 检查机器人名称是否已存在（排除指定 botId）
export function isRobotNameExists(name: string, excludeBotId?: string): boolean {
  const robots = listAllRobots();
  for (const robot of robots) {
    if (robot.name === name && robot.botId !== excludeBotId) {
      return true;
    }
  }
  return false;
}

/**
 * 通过等待用户消息来识别用户 ID（使用已有的 client）
 */
export async function detectUserIdFromMessage(
  client: any,
  timeoutSeconds: number = 60
): Promise<string | null> {
  return new Promise((resolve) => {
    if (!client.isConnected()) {
      console.log('\n[config] 客户端未连接');
      resolve(null);
      return;
    }

    console.log('\n[config] ✅ 连接成功！');
    console.log('\n╔════════════════════════════════════════════════════════╗');
    console.log('║  请让需要接收审批消息的人，在企业微信中给机器人发送      ║');
    console.log('║  一条消息（任意内容），系统将自动识别其用户 ID          ║');
    console.log('╚════════════════════════════════════════════════════════╝');
    console.log(`\n[config] 等待消息中...（${timeoutSeconds}秒内）`);

    // 设置超时
    const timeout = setTimeout(() => {
      console.log(`\n[config] 等待超时（${timeoutSeconds}秒），未收到用户消息`);
      resolve(null);
    }, timeoutSeconds * 1000);

    // 轮询等待消息
    const pollInterval = setInterval(async () => {
      const messages = client.getPendingMessages(false);
      if (messages.length > 0) {
        clearTimeout(timeout);
        clearInterval(pollInterval);

        const msg = messages[0];
        const userId = msg.from_userid;

        console.log(`\n[config] ✅ 收到消息！`);
        console.log(`[config] 识别到用户 ID: ${userId}`);

        // 发送确认消息
        try {
          await client.sendText(`**机器人配置成功！**\n\n默认向用户 ID: \`${userId}\` 发送消息互动。\n\n您现在可以使用 Claude Code 审批功能了。`, userId);
          console.log(`[config] 已发送确认消息到 ${userId}`);
        } catch (err) {
          console.log(`[config] 发送确认消息失败: ${err}`);
        }

        resolve(userId);
      }
    }, 1000);
  });
}

/**
 * 检查并获取配置
 *
 * 优先级：
 * 1. 环境变量（WECOM_BOT_ID, WECOM_SECRET, WECOM_TARGET_USER）
 * 2. 保存的配置文件（~/.wecom-aibot-mcp/config.json）
 * 3. 运行配置向导
 */
export async function getOrInitConfig(): Promise<WecomConfig> {
  // 1. 检查环境变量（最高优先级，支持多实例场景）
  const envBotId = process.env.WECOM_BOT_ID;
  const envSecret = process.env.WECOM_SECRET;
  const envTargetUser = process.env.WECOM_TARGET_USER;

  if (envBotId && envSecret && envTargetUser) {
    console.log(`[config] 使用环境变量配置: Bot ID=${envBotId}, 目标用户=${envTargetUser}`);
    return {
      botId: envBotId,
      secret: envSecret,
      targetUserId: envTargetUser,
    };
  }

  // 部分环境变量存在时给出提示
  if (envBotId || envSecret || envTargetUser) {
    console.log('[config] 检测到部分环境变量，但配置不完整');
    console.log('[config] 需要同时设置: WECOM_BOT_ID, WECOM_SECRET, WECOM_TARGET_USER');
  }

  // 2. 检查保存的配置文件
  const savedConfig = loadConfig();

  if (savedConfig && savedConfig.botId && savedConfig.secret && savedConfig.targetUserId) {
    console.log(`[config] 已加载配置: Bot ID=${savedConfig.botId}, 目标用户=${savedConfig.targetUserId}`);
    return savedConfig;
  }

  // 3. 非 TTY（MCP stdio 模式）不能启动交互向导
  if (!process.stdin.isTTY) {
    logger.error('[config] 未找到配置，且当前为非交互模式。');
    logger.error('[config] 请在 ~/.claude.json 的 mcpServers 中设置环境变量:');
    logger.error('[config]   WECOM_BOT_ID, WECOM_SECRET, WECOM_TARGET_USER');
    process.exit(1);
  }

  // 4. TTY 模式下运行配置向导
  console.log('[config] 未找到有效配置，启动配置向导...\n');
  const result = await runConfigWizard();
  return result.config;
}