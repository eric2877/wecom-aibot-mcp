/**
 * 配置向导模块
 *
 * 首次运行时引导用户配置 Bot ID、Secret 和默认目标用户
 */
import * as readline from 'readline';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface WecomConfig {
  botId: string;
  secret: string;
  targetUserId: string;
  targetUserName?: string;
}

const CONFIG_DIR = path.join(os.homedir(), '.wecom-aibot-mcp');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const CLAUDE_CONFIG_FILE = path.join(os.homedir(), '.claude.json');
const CLAUDE_SETTINGS_FILE = path.join(os.homedir(), '.claude', 'settings.local.json');
const HOOK_SCRIPT_PATH = path.join(CONFIG_DIR, 'permission-hook.sh');
const HOOK_PORT = 18963;

// MCP 工具权限列表（需要预授权以避免 headless 模式阻断）
const MCP_TOOL_PERMISSIONS = [
  'mcp__wecom-aibot__send_message',
  'mcp__wecom-aibot__send_approval_request',
  'mcp__wecom-aibot__get_approval_result',
  'mcp__wecom-aibot__check_connection',
  'mcp__wecom-aibot__get_pending_messages',
  'mcp__wecom-aibot__get_setup_guide',
  'mcp__wecom-aibot__add_robot_config',
];

// 确保配置目录存在
function ensureConfigDir() {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

// 读取已保存的配置
export function loadConfig(): WecomConfig | null {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const content = fs.readFileSync(CONFIG_FILE, 'utf-8');
      return JSON.parse(content);
    }
  } catch (err) {
    console.error('[config] 读取配置失败:', err);
  }
  return null;
}

// 生成并写入 hook 脚本（非阻塞轮询模式）
function writeHookScript() {
  const script = `#!/bin/bash
# wecom-aibot-mcp PermissionRequest hook
# 非阻塞模式：发送审批请求后轮询结果

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')

# MCP 工具本身不需要拦截
if [[ "$TOOL_NAME" == mcp__* ]]; then
  printf '%s\\n' '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
  exit 0
fi

# 只读工具不需要拦截
case "$TOOL_NAME" in
  Read|Glob|Grep|LS|TaskList|TaskGet|TaskOutput|CronList|AskUserQuestion|Skill|ListMcpResourcesTool|EnterPlanMode|ExitPlanMode|WebSearch|ToolSearch)
    printf '%s\\n' '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
    exit 0
    ;;
esac

# 检查审批服务是否在线
HEALTH=$(curl -s -m 2 "http://127.0.0.1:${HOOK_PORT}/health" 2>/dev/null)
if ! echo "$HEALTH" | jq -e '.connected == true' > /dev/null 2>&1; then
  # 服务不在线或未连接微信，回退到默认 UI
  exit 0
fi

# 发送审批请求（非阻塞，立即返回 taskId）
TOOL_INPUT=$(echo "$INPUT" | jq -c '.tool_input // {}')
BODY=$(jq -n --arg tool_name "$TOOL_NAME" --argjson tool_input "$TOOL_INPUT" \
  '{"tool_name":$tool_name,"tool_input":$tool_input}')
RESPONSE=$(curl -s -X POST "http://127.0.0.1:${HOOK_PORT}/approve" \\
  -H "Content-Type: application/json" \\
  -d "$BODY")

TASK_ID=$(echo "$RESPONSE" | jq -r '.taskId // empty')
if [[ -z "$TASK_ID" ]]; then
  # 发送失败，回退默认 UI
  exit 0
fi

# 轮询审批结果（每 2 秒检查一次，最多 300 次 = 10 分钟）
MAX_POLL=300
POLL_COUNT=0
while [[ $POLL_COUNT -lt $MAX_POLL ]]; do
  sleep 2
  STATUS=$(curl -s "http://127.0.0.1:${HOOK_PORT}/approval_status/$TASK_ID")
  RESULT=$(echo "$STATUS" | jq -r '.result // empty')

  if [[ "$RESULT" == "allow-once" || "$RESULT" == "allow-always" ]]; then
    printf '%s\\n' '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
    exit 0
  elif [[ "$RESULT" == "deny" ]]; then
    printf '%s\\n' '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"用户拒绝"}}}'
    exit 0
  fi

  POLL_COUNT=$((POLL_COUNT + 1))
done

# 超时，回退默认 UI
exit 0
`;

  ensureConfigDir();
  fs.writeFileSync(HOOK_SCRIPT_PATH, script, { mode: 0o755 });
  console.log(`[config] Hook 脚本已写入: ${HOOK_SCRIPT_PATH}`);
}

// 写入 MCP Server 配置到 ~/.claude.json
function writeMcpServerConfig(config: WecomConfig) {
  try {
    // 读取现有配置
    let claudeConfig: any = {};
    if (fs.existsSync(CLAUDE_CONFIG_FILE)) {
      const content = fs.readFileSync(CLAUDE_CONFIG_FILE, 'utf-8');
      claudeConfig = JSON.parse(content);
    }

    // 确保 mcpServers 存在
    if (!claudeConfig.mcpServers) claudeConfig.mcpServers = {};

    // 检查是否已有 wecom-aibot 配置
    if (claudeConfig.mcpServers['wecom-aibot']) {
      console.log('[config] ~/.claude.json 中已存在 wecom-aibot 配置，跳过写入');
      return true;
    }

    // 写入 MCP Server 配置
    claudeConfig.mcpServers['wecom-aibot'] = {
      command: 'npx',
      args: ['@various/wecom-aibot-mcp'],
      env: {
        WECOM_BOT_ID: config.botId,
        WECOM_SECRET: config.secret,
        WECOM_TARGET_USER: config.targetUserId,
      },
    };

    fs.writeFileSync(CLAUDE_CONFIG_FILE, JSON.stringify(claudeConfig, null, 2));
    console.log(`[config] MCP Server 配置已写入 ~/.claude.json`);
    return true;
  } catch (err) {
    console.error('[config] 写入 ~/.claude.json 失败:', err);
    console.log('[config] ⚠️  请手动将以下配置添加到 ~/.claude.json:');
    console.log(JSON.stringify({
      mcpServers: {
        'wecom-aibot': {
          command: 'npx',
          args: ['@various/wecom-aibot-mcp'],
          env: {
            WECOM_BOT_ID: config.botId,
            WECOM_SECRET: config.secret,
            WECOM_TARGET_USER: config.targetUserId,
          },
        },
      },
    }, null, 2));
    return false;
  }
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

    // 注册 PermissionRequest hook（先生成脚本）
    writeHookScript();
    if (!settings.hooks) settings.hooks = {};
    settings.hooks['PermissionRequest'] = [
      {
        matcher: '',
        hooks: [{ type: 'command', command: HOOK_SCRIPT_PATH }],
      },
    ];

    fs.writeFileSync(CLAUDE_SETTINGS_FILE, JSON.stringify(settings, null, 2));
    console.log(`[config] PermissionRequest hook 已注册: ${HOOK_SCRIPT_PATH}`);
  } catch (err) {
    console.error('[config] 写入配置失败:', err);
    console.log('[config] ⚠️  请手动配置，详见 README');
  }
}

// 确保 hook 已安装（幂等，可多次调用）
export function ensureHookInstalled() {
  writeMcpPermissions();
}

// 保存配置（并自动写入 MCP 权限和 Server 配置）
export function saveConfig(config: WecomConfig) {
  ensureConfigDir();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  console.log(`[config] 配置已保存到 ${CONFIG_FILE}`);

  // 自动写入 MCP Server 配置到 ~/.claude.json
  writeMcpServerConfig(config);

  // 自动写入 MCP 工具权限和 Hook 到 ~/.claude/settings.local.json
  writeMcpPermissions();
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
export async function runConfigWizard(): Promise<WecomConfig> {
  console.log('\n');
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║     企业微信智能机器人 MCP 服务 - 配置向导                  ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log('\n请提供以下配置信息：\n');

  const rl = createRL();

  try {
    // 1. 获取 Bot ID
    let botId = await question(rl, 'Bot ID: ');
    while (!botId) {
      console.log('Bot ID 不能为空');
      botId = await question(rl, 'Bot ID: ');
    }

    // 2. 获取 Secret
    let secret = await question(rl, 'Secret: ');
    while (!secret) {
      console.log('Secret 不能为空');
      secret = await question(rl, 'Secret: ');
    }

    // 3. 获取默认目标用户
    console.log('\n请输入默认交互用户的 User ID（企业微信用户账号）');
    console.log('提示：User ID 通常是员工的企业微信账号，如 "zhangsan"、"lisi" 等\n');

    let targetUserId = await question(rl, '默认目标用户 ID: ');
    while (!targetUserId) {
      console.log('用户 ID 不能为空');
      targetUserId = await question(rl, '默认目标用户 ID: ');
    }

    const config: WecomConfig = {
      botId,
      secret,
      targetUserId,
    };

    // 4. 确认配置
    console.log('\n─────────────────────────────────────');
    console.log('配置确认：');
    console.log(`  Bot ID:     ${botId}`);
    console.log(`  Secret:     ${secret.slice(0, 8)}...${secret.slice(-4)}`);
    console.log(`  目标用户:   ${targetUserId}`);
    console.log('─────────────────────────────────────\n');

    const confirm = await question(rl, '确认保存配置？(Y/n): ');

    if (confirm.toLowerCase() === 'n') {
      console.log('[config] 配置已取消');
      process.exit(0);
    }

    saveConfig(config);
    return config;

  } finally {
    rl.close();
  }
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
    console.error('[config] 未找到配置，且当前为非交互模式。');
    console.error('[config] 请在 ~/.claude.json 的 mcpServers 中设置环境变量:');
    console.error('[config]   WECOM_BOT_ID, WECOM_SECRET, WECOM_TARGET_USER');
    process.exit(1);
  }

  // 4. TTY 模式下运行配置向导
  console.log('[config] 未找到有效配置，启动配置向导...\n');
  return runConfigWizard();
}