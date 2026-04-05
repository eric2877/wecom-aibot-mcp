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

export interface WecomConfig {
  botId: string;
  secret: string;
  targetUserId: string;
  targetUserName?: string;
}

const CONFIG_DIR = path.join(os.homedir(), '.wecom-aibot-mcp');
const BOT_CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const CLAUDE_CONFIG_FILE = path.join(os.homedir(), '.claude.json');
const CLAUDE_SETTINGS_FILE = path.join(os.homedir(), '.claude', 'settings.local.json');
const HOOK_SCRIPT_PATH = path.join(CONFIG_DIR, 'permission-hook.sh');

// Skill 模板路径（包内）
const SKILL_TEMPLATE_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'skills', 'headless-mode');
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
        return {
          botId: config.botId,
          secret: config.secret,
          targetUserId: config.targetUserId,
        };
      }
    }
  } catch (err) {
    console.error('[config] 读取配置失败:', err);
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
    console.error('[config] 删除配置失败:', err);
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
    console.error('[config] 删除 hook 失败:', err);
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
    console.error('[config] 删除 skill 失败:', err);
  }
}

// 删除单个 MCP 配置（按实例名）
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
    console.error('[config] 删除配置失败:', err);
    return false;
  }
}

// 交互式删除机器人配置
export async function deleteMcpConfigInteractive(instanceName?: string): Promise<void> {
  const instances = listAllMcpInstances();

  if (instances.length === 0) {
    console.log('[config] 没有找到任何企业微信机器人配置');
    return;
  }

  // 如果提供了实例名，直接删除
  if (instanceName) {
    deleteMcpConfig(instanceName);
    return;
  }

  // 否则显示列表让用户选择
  console.log('\n企业微信机器人配置列表：\n');
  instances.forEach((inst, idx) => {
    console.log(`  ${idx + 1}. ${inst.name} (Bot ID: ${inst.config.botId.slice(0, 12)}..., 用户: ${inst.config.targetUserId})`);
  });
  console.log(`  0. 取消\n`);

  const rl = createRL();
  try {
    const choice = await question(rl, '请选择要删除的配置序号: ');
    const choiceNum = parseInt(choice);

    if (choiceNum === 0) {
      console.log('[config] 已取消');
      return;
    }

    if (choiceNum < 1 || choiceNum > instances.length) {
      console.log('[config] 无效选择');
      return;
    }

    const selected = instances[choiceNum - 1];
    const confirm = await question(rl, `确认删除 "${selected.name}"？(y/N): `);

    if (confirm.toLowerCase() === 'y') {
      deleteMcpConfig(selected.name);
      console.log(`[config] 请重启 Claude Code 以生效\n`);
    } else {
      console.log('[config] 已取消');
    }
  } finally {
    rl.close();
  }
}

// 完全卸载（删除所有相关配置）
export function uninstall() {
  console.log('\n[config] 开始卸载 wecom-aibot-mcp...\n');

  deleteConfig();  // 删除 ~/.claude.json 中的配置
  deleteHook();
  deleteSkills();

  // 删除运行时文件目录
  if (fs.existsSync(CONFIG_DIR)) {
    try {
      // 删除所有 port-* 和 headless-* 文件
      const files = fs.readdirSync(CONFIG_DIR);
      for (const file of files) {
        if (file.startsWith('port-') || file.startsWith('headless-')) {
          fs.unlinkSync(path.join(CONFIG_DIR, file));
        }
      }
      // 如果目录为空，删除目录
      const remainingFiles = fs.readdirSync(CONFIG_DIR);
      if (remainingFiles.length === 0) {
        fs.rmSync(CONFIG_DIR);
        console.log('[config] 已删除配置目录');
      }
    } catch (err) {
      console.error('[config] 删除配置目录失败:', err);
    }
  }

  console.log('\n[config] 卸载完成');
  console.log('[config] 如需重新安装，请运行: npx @vrs-soft/wecom-aibot-mcp --config\n');
}

// 生成并写入 hook 脚本（HTTP Transport 版本）
function writeHookScript() {
  const script = `#!/bin/bash
# wecom-aibot-mcp PermissionRequest hook
# HTTP Transport 版本
#
# 固定端口: 18963
# 直接检查 $(pwd)/.claude/headless.json

MCP_PORT=18963

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')

# MCP 工具本身不需要拦截
if [[ "$TOOL_NAME" == mcp__* ]]; then
  printf '%s\\n' '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
  exit 0
fi

# 只读工具不需要拦截
case "$TOOL_NAME" in
  Read|Glob|Grep|LS|TaskList|TaskGet|TaskOutput|TaskStop|CronList|CronCreate|CronDelete|AskUserQuestion|Skill|ListMcpResourcesTool|EnterPlanMode|ExitPlanMode|WebSearch|WebFetch|NotebookEdit)
    printf '%s\\n' '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
    exit 0
    ;;
esac

# 直接检查项目目录的 headless 状态文件
PROJECT_DIR=$(pwd)
HEADLESS_FILE="$PROJECT_DIR/.claude/headless.json"

# 不在 headless 模式
if [[ ! -f "$HEADLESS_FILE" ]]; then
  exit 0
fi

# 检查 MCP Server 是否在线
HEALTH=$(curl -s -m 2 "http://127.0.0.1:$MCP_PORT/health" 2>/dev/null)
if ! echo "$HEALTH" | jq -e '.status == "ok"' > /dev/null 2>&1; then
  exit 0
fi

# 发送审批请求（使用 pwd 作为 projectDir）
TOOL_INPUT=$(echo "$INPUT" | jq -c '.tool_input // {}')
BODY=$(jq -n --arg tool_name "$TOOL_NAME" --argjson tool_input "$TOOL_INPUT" --arg project_dir "$PROJECT_DIR" \\
  '{"tool_name":$tool_name,"tool_input":$tool_input,"projectDir":$project_dir}')

RESPONSE=$(curl -s -m 10 -X POST "http://127.0.0.1:$MCP_PORT/approve" \\
  -H "Content-Type: application/json" \\
  -d "$BODY")

TASK_ID=$(echo "$RESPONSE" | jq -r '.taskId // empty')
if [[ -z "$TASK_ID" ]]; then
  exit 0
fi

# 轮询审批结果（带超时：10 分钟）
POLL_COUNT=0
MAX_POLL=300  # 300 * 2秒 = 600秒 = 10分钟

while [[ $POLL_COUNT -lt $MAX_POLL ]]; do
  sleep 2
  POLL_COUNT=$((POLL_COUNT + 1))

  STATUS=$(curl -s -m 3 "http://127.0.0.1:$MCP_PORT/approval_status/$TASK_ID" 2>/dev/null)
  RESULT=$(echo "$STATUS" | jq -r '.result // empty')

  if [[ "$RESULT" == "allow-once" || "$RESULT" == "allow-always" ]]; then
    printf '%s\\n' '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
    exit 0
  elif [[ "$RESULT" == "deny" ]]; then
    printf '%s\\n' '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"用户拒绝"}}}'
    exit 0
  fi
done

# 超时处理：智能代批
# 规则：删除命令→拒绝，项目内操作→允许，项目外操作→拒绝

# 检查是否是删除命令
IS_DELETE=0
if [[ "$TOOL_NAME" == "Bash" ]]; then
  CMD=$(echo "$TOOL_INPUT" | jq -r '.command // empty')
  if [[ "$CMD" =~ ^rm\\ ]] || [[ "$CMD" =~ \\ rm\\ ]] || \
     [[ "$CMD" =~ ^rmdir\\ ]] || [[ "$CMD" =~ \\ rmdir\\ ]] || \
     [[ "$CMD" =~ ^unlink\\ ]] || [[ "$CMD" =~ rm\\ -rf ]]; then
    IS_DELETE=1
  fi
fi

# 删除操作 → 永远拒绝
if [[ $IS_DELETE -eq 1 ]]; then
  printf '%s\\n' '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"超时自动拒绝：删除操作需人工确认"}}}'
  exit 0
fi

# 检查操作路径是否在项目内
IS_IN_PROJECT=0

case "$TOOL_NAME" in
  Bash)
    CMD=$(echo "$TOOL_INPUT" | jq -r '.command // empty')
    if [[ "$CMD" == *"$PROJECT_DIR"* ]] || \
       [[ "$CMD" =~ ^\\./ ]] || \
       [[ "$CMD" =~ ^npm\\ ]] || \
       [[ "$CMD" =~ ^npx\\ ]] || \
       [[ "$CMD" =~ ^git\\ ]] || \
       [[ "$CMD" =~ ^node\\ ]]; then
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

# 根据项目内/外决策
if [[ $IS_IN_PROJECT -eq 1 ]]; then
  printf '%s\\n' '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow","message":"超时自动允许：项目内操作"}}}'
else
  printf '%s\\n' '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"超时自动拒绝：项目外操作需人工确认"}}}'
fi
`;

  ensureConfigDir();
  fs.writeFileSync(HOOK_SCRIPT_PATH, script, { mode: 0o755 });
  console.log(`[config] Hook 脚本已写入: ${HOOK_SCRIPT_PATH}`);
}

// 写入 MCP Server 配置到 ~/.claude.json
function writeMcpServerConfig(config: WecomConfig, instanceName?: string) {
  try {
    // 1. 写入机器人配置到 ~/.wecom-aibot-mcp/config.json
    ensureConfigDir();
    const botConfig = {
      botId: config.botId,
      secret: config.secret,
      targetUserId: config.targetUserId,
    };
    fs.writeFileSync(BOT_CONFIG_FILE, JSON.stringify(botConfig, null, 2));
    console.log('[config] 机器人配置已写入 ~/.wecom-aibot-mcp/config.json');

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
    console.error('[config] 写入配置失败:', err);
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

    // 先连接验证凭证
    console.log('\n[config] 正在连接企业微信...');
    const { initClient } = await import('./client.js');
    const client = initClient(botId, secret, 'placeholder');

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
    const robotConfig = {
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
    console.error('[config] 添加配置失败:', err);
    rl.close();
  }
}

// 列出所有机器人配置
export function listAllRobots(): Array<{ name: string; botId: string; targetUserId: string; isDefault: boolean }> {
  const robots: Array<{ name: string; botId: string; targetUserId: string; isDefault: boolean }> = [];

  // 默认配置
  if (fs.existsSync(BOT_CONFIG_FILE)) {
    try {
      const config = JSON.parse(fs.readFileSync(BOT_CONFIG_FILE, 'utf-8'));
      robots.push({
        name: config.nameTag || '默认机器人',
        botId: config.botId,
        targetUserId: config.targetUserId,
        isDefault: true,
      });
    } catch (e) {
      // ignore
    }
  }

  // 其他机器人配置
  const files = fs.readdirSync(CONFIG_DIR).filter(f => f.startsWith('robot-') && f.endsWith('.json'));
  for (const file of files) {
    try {
      const config = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, file), 'utf-8'));
      robots.push({
        name: config.nameTag || file,
        botId: config.botId,
        targetUserId: config.targetUserId,
        isDefault: false,
      });
    } catch (e) {
      // ignore
    }
  }

  return robots;
}

// 安装 skill 文件到 ~/.claude/skills/
function installSkills() {
  try {
    const claudeSkillsDir = path.join(os.homedir(), '.claude', 'skills', 'headless-mode');
    const skillFile = path.join(claudeSkillsDir, 'SKILL.md');

    // 检查是否已存在
    if (fs.existsSync(skillFile)) {
      console.log('[config] skill 文件已存在，跳过安装');
      return;
    }

    // 确保目录存在
    if (!fs.existsSync(claudeSkillsDir)) {
      fs.mkdirSync(claudeSkillsDir, { recursive: true });
    }

    // 从包内复制 skill 文件
    // ES modules: 使用 import.meta.url 获取当前模块路径
    const currentDir = path.dirname(new URL(import.meta.url).pathname);
    const sourceSkillFile = path.join(currentDir, '..', 'skills', 'headless-mode', 'SKILL.md');

    if (fs.existsSync(sourceSkillFile)) {
      fs.copyFileSync(sourceSkillFile, skillFile);
      console.log(`[config] skill 文件已安装: ${skillFile}`);
    } else {
      // 开发模式：从源码目录复制
      const devSkillFile = path.join(process.cwd(), 'skills', 'headless-mode', 'SKILL.md');
      if (fs.existsSync(devSkillFile)) {
        fs.copyFileSync(devSkillFile, skillFile);
        console.log(`[config] skill 文件已安装: ${skillFile}`);
      } else {
        console.log('[config] ⚠️  skill 文件未找到，请手动创建 ~/.claude/skills/headless-mode/SKILL.md');
      }
    }
  } catch (err) {
    console.error('[config] 安装 skill 文件失败:', err);
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
  installSkills();
}

// 保存配置（直接写入 ~/.claude.json）
export function saveConfig(config: WecomConfig, instanceName?: string) {
  ensureConfigDir();  // 确保运行时文件目录存在

  // 写入 MCP Server 配置到 ~/.claude.json
  writeMcpServerConfig(config, instanceName);

  // 写入 MCP 工具权限和 Hook 到 ~/.claude/settings.local.json
  writeMcpPermissions();

  // 安装 skill 到项目目录
  installSkill(process.cwd());
}

/**
 * 安装 headless-mode skill 到项目目录
 */
export function installSkill(projectDir: string): void {
  const skillDir = path.join(projectDir, '.claude', 'skills', 'headless-mode');
  const skillFile = path.join(skillDir, 'SKILL.md');

  // 确保 skill 目录存在
  if (!fs.existsSync(skillDir)) {
    fs.mkdirSync(skillDir, { recursive: true });
  }

  // 检查模板文件是否存在
  if (!fs.existsSync(SKILL_TEMPLATE_FILE)) {
    console.log('[config] Skill 模板文件不存在，跳过安装');
    return;
  }

  // 写入 skill 文件
  fs.copyFileSync(SKILL_TEMPLATE_FILE, skillFile);
  console.log(`[config] 已安装 skill 到 ${skillFile}`);
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
    // 检查是否有多个机器人配置
    const instances = listAllMcpInstances();
    let instanceName = 'wecom-aibot';

    if (instances.length > 1) {
      // 多个机器人，让用户选择要修改哪个
      console.log('\n检测到多个机器人配置，请选择要修改的：\n');
      instances.forEach((inst, idx) => {
        console.log(`  ${idx + 1}. ${inst.name} (Bot ID: ${inst.config.botId.slice(0, 12)}...)`);
      });
      console.log(`  ${instances.length + 1}. 添加新机器人\n`);

      const choice = await question(rl, '请输入序号: ');
      const choiceNum = parseInt(choice);

      if (choiceNum >= 1 && choiceNum <= instances.length) {
        instanceName = instances[choiceNum - 1].name;
        console.log(`\n已选择修改: ${instanceName}\n`);
      } else if (choiceNum === instances.length + 1) {
        // 添加新机器人
        const newName = await question(rl, '请输入新实例名称: ');
        if (!newName) {
          console.log('[config] 实例名称不能为空');
          process.exit(1);
        }
        instanceName = newName;
        console.log(`\n将创建新实例: ${instanceName}\n`);
      } else {
        console.log('[config] 无效选择');
        process.exit(1);
      }
    } else if (instances.length === 1) {
      instanceName = instances[0].name;
      console.log(`\n将修改现有配置: ${instanceName}\n`);
    } else {
      console.log('\n将创建默认配置: wecom-aibot\n');
    }

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

    // 3. 目标用户 ID 稍后通过消息自动识别
    console.log('\n─────────────────────────────────────');
    console.log('配置确认：');
    console.log(`  实例名称:   ${instanceName}`);
    console.log(`  Bot ID:     ${botId}`);
    console.log(`  Secret:     ${secret.slice(0, 8)}...${secret.slice(-4)}`);
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
    };

    return { config, instanceName };

  } finally {
    rl.close();
  }
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
    console.error('[config] 未找到配置，且当前为非交互模式。');
    console.error('[config] 请在 ~/.claude.json 的 mcpServers 中设置环境变量:');
    console.error('[config]   WECOM_BOT_ID, WECOM_SECRET, WECOM_TARGET_USER');
    process.exit(1);
  }

  // 4. TTY 模式下运行配置向导
  console.log('[config] 未找到有效配置，启动配置向导...\n');
  const result = await runConfigWizard();
  return result.config;
}