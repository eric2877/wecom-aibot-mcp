/**
 * 配置向导模块
 *
 * 首次运行时引导用户配置 Bot ID、Secret 和默认目标用户
 *
 * 配置存储位置：
 * - 机器人配置：~/.wecom-aibot-mcp/robot-*.json
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
const VERSION_FILE = path.join(CONFIG_DIR, 'version.json');
const SERVER_CONFIG_FILE = path.join(CONFIG_DIR, 'server.json');  // HTTP Server 配置（auth token 等）
const CLAUDE_CONFIG_FILE = path.join(os.homedir(), '.claude.json');
const CLAUDE_SETTINGS_FILE = path.join(os.homedir(), '.claude', 'settings.local.json');
// v3.0+：hook 改用 Node.js（跨平台）。旧路径仅用于 --upgrade / --uninstall 清理。
const HOOK_SCRIPT_PATH = path.join(CONFIG_DIR, 'permission-hook.js');
const STOP_HOOK_SCRIPT_PATH = path.join(CONFIG_DIR, 'stop-hook.js');
const LEGACY_HOOK_SCRIPT_PATH = path.join(CONFIG_DIR, 'permission-hook.sh');
const LEGACY_STOP_HOOK_SCRIPT_PATH = path.join(CONFIG_DIR, 'stop-hook.sh');

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

// 从 ~/.wecom-aibot-mcp/robot-*.json 读取第一个有效配置
export function loadConfig(): WecomConfig | null {
  try {
    if (!fs.existsSync(CONFIG_DIR)) return null;
    const files = fs.readdirSync(CONFIG_DIR).filter(f => f.startsWith('robot-') && f.endsWith('.json'));
    for (const file of files) {
      const content = fs.readFileSync(path.join(CONFIG_DIR, file), 'utf-8');
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

// 设置/清除 HTTP Server 的 auth token（写入 server.json）
export function setAuthToken(token: string | undefined): boolean {
  ensureConfigDir();
  let config: any = {};
  if (fs.existsSync(SERVER_CONFIG_FILE)) {
    try {
      config = JSON.parse(fs.readFileSync(SERVER_CONFIG_FILE, 'utf-8'));
    } catch {
      // ignore
    }
  }
  if (token) {
    config.authToken = token;
  } else {
    delete config.authToken;
    // 如果 config 为空，删除文件
    if (Object.keys(config).length === 0) {
      if (fs.existsSync(SERVER_CONFIG_FILE)) fs.unlinkSync(SERVER_CONFIG_FILE);
      return true;
    }
  }
  fs.writeFileSync(SERVER_CONFIG_FILE, JSON.stringify(config, null, 2));
  return true;
}

// 获取 HTTPS 证书配置（从 server.json 读取）
export function getHttpsConfig(): { certPath: string; keyPath: string } | null {
  if (!fs.existsSync(SERVER_CONFIG_FILE)) return null;
  try {
    const config = JSON.parse(fs.readFileSync(SERVER_CONFIG_FILE, 'utf-8'));
    if (config.certPath && config.keyPath) {
      return { certPath: config.certPath, keyPath: config.keyPath };
    }
    return null;
  } catch {
    return null;
  }
}

// 设置 HTTPS 证书配置（写入 server.json）
export function setHttpsConfig(certPath: string, keyPath: string): boolean {
  ensureConfigDir();
  let config: any = {};
  if (fs.existsSync(SERVER_CONFIG_FILE)) {
    try {
      config = JSON.parse(fs.readFileSync(SERVER_CONFIG_FILE, 'utf-8'));
    } catch {
      // ignore
    }
  }
  config.certPath = certPath;
  config.keyPath = keyPath;
  fs.writeFileSync(SERVER_CONFIG_FILE, JSON.stringify(config, null, 2));
  return true;
}

// 更新 ~/.claude.json 中 wecom-aibot MCP 配置的 auth headers
export function updateMcpAuthHeaders(token?: string): void {
  if (!fs.existsSync(CLAUDE_CONFIG_FILE)) return;
  try {
    const content = fs.readFileSync(CLAUDE_CONFIG_FILE, 'utf-8');
    const claudeConfig = JSON.parse(content);
    if (!claudeConfig.mcpServers) return;

    // 更新所有 wecom-aibot 相关的 HTTP MCP 配置
    for (const name of Object.keys(claudeConfig.mcpServers)) {
      if (name.startsWith('wecom-aibot') && claudeConfig.mcpServers[name].type === 'http') {
        if (token) {
          claudeConfig.mcpServers[name].headers = { Authorization: `Bearer ${token}` };
        } else {
          delete claudeConfig.mcpServers[name].headers;
        }
      }
    }
    fs.writeFileSync(CLAUDE_CONFIG_FILE, JSON.stringify(claudeConfig, null, 2));
  } catch {
    // ignore
  }
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

      // 删除 hook 脚本文件（含旧版 .sh 残留）
      for (const p of [HOOK_SCRIPT_PATH, STOP_HOOK_SCRIPT_PATH, LEGACY_HOOK_SCRIPT_PATH, LEGACY_STOP_HOOK_SCRIPT_PATH]) {
        if (fs.existsSync(p)) {
          fs.unlinkSync(p);
          console.log(`[config] 已删除 hook 文件: ${path.basename(p)}`);
        }
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

    // 从 robot-*.json 中查找
    if (fs.existsSync(CONFIG_DIR)) {
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

    // 直接删除
    fs.unlinkSync(configFile);
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

  // 删除整个配置目录（包括 robot-*.json、hook 脚本、日志等）
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

// 拷贝包内编译后的 hook 脚本到 ~/.wecom-aibot-mcp/permission-hook.js
function copyHook(srcRelative: string, dest: string, label: string) {
  const src = path.join(__dirname, srcRelative);
  if (!fs.existsSync(src)) {
    logger.error(`[config] hook 源文件不存在: ${src}`);
    return false;
  }
  ensureConfigDir();
  fs.copyFileSync(src, dest);
  console.log(`[config] ${label} 已写入: ${dest}`);
  return true;
}

// 安装 hook 脚本（v3.0+ 改用 Node.js，跨平台）
function writeHookScript() {
  if (fs.existsSync(LEGACY_HOOK_SCRIPT_PATH)) {
    try { fs.unlinkSync(LEGACY_HOOK_SCRIPT_PATH); console.log('[config] 已清理旧版 permission-hook.sh'); } catch { /* ignore */ }
  }
  copyHook(path.join('hooks', 'permission-hook.js'), HOOK_SCRIPT_PATH, 'PermissionRequest hook');
}

// 安装 Stop hook 脚本（v3.0+ Node.js）
function writeStopHookScript() {
  if (fs.existsSync(LEGACY_STOP_HOOK_SCRIPT_PATH)) {
    try { fs.unlinkSync(LEGACY_STOP_HOOK_SCRIPT_PATH); console.log('[config] 已清理旧版 stop-hook.sh'); } catch { /* ignore */ }
  }
  copyHook(path.join('hooks', 'stop-hook.js'), STOP_HOOK_SCRIPT_PATH, 'Stop hook');
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
      // 新机器人：统一使用 robot-*.json
      const newConfigPath = path.join(CONFIG_DIR, `robot-${Date.now()}.json`);
      fs.writeFileSync(newConfigPath, JSON.stringify(botConfig, null, 2));
      console.log(`[config] 已添加新机器人配置: ${newConfigPath}`);
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
    console.log('~/.wecom-aibot-mcp/robot-*.json:');
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

    // 获取文档 MCP URL（可选）
    console.log('');
    const docMcpUrl = await question(rl, '文档 MCP URL（可选，企业微信管理后台获取，留空跳过）: ');

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
      ...(docMcpUrl ? { doc_mcp_url: docMcpUrl } : {}),
    };

    // 确保配置目录存在
    ensureConfigDir();

    // 统一使用 robot-*.json 格式
    const robotConfigPath = path.join(CONFIG_DIR, `robot-${Date.now()}.json`);
    fs.writeFileSync(robotConfigPath, JSON.stringify(robotConfig, null, 2));
    console.log(`\n[config] ✅ 已添加机器人: ${robotName}`);

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

  // 所有机器人配置（统一 robot-*.json 格式）
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

    // 注意：PermissionRequest hook 通过项目级 settings.json 配置，不注册全局 hook
    // HTTP 模式：enter_headless_mode 在项目目录写入 hook
    // Channel 模式：由 Claude Code 自动审批，不需要 hook

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

export type InstallMode = 'full' | 'http-only' | 'channel-only' | 'remote' | 'remote-channel';

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
export function ensureGlobalConfigs(mode: InstallMode = 'full', remoteOptions?: { url: string; token: string }): { upgraded: boolean; previousVersion?: string } {
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
    writeVersionFile(mode);
    return { upgraded, previousVersion };
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
  // （HTTP MCP daemon 在远端，本地不需要 HTTP transport client config）
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

    // 只写 Channel MCP 配置（带 MCP_URL + MCP_AUTH_TOKEN），HTTP MCP 由远端 daemon 提供，本地无需 client 配置
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

    // Channel 模式需要权限配置
    writeMcpPermissions();
    console.log('[config] 已写入权限配置到 ~/.claude/settings.local.json');

    writeVersionFile(mode, remoteOptions);
    return { upgraded, previousVersion };
  }

  // 1. 强制写入 MCP 配置到 ~/.claude.json
  let claudeConfig: any = {};
  if (fs.existsSync(CLAUDE_CONFIG_FILE)) {
    const content = fs.readFileSync(CLAUDE_CONFIG_FILE, 'utf-8');
    claudeConfig = JSON.parse(content);
  }

  if (!claudeConfig.mcpServers) claudeConfig.mcpServers = {};

  // 从 node_modules 运行（npm/npx 安装）时用 npx，本地开发时用绝对路径
  const isPackageInstall = __dirname.includes('node_modules');
  const channelCmd = isPackageInstall
    ? { command: 'npx', args: ['-y', '@vrs-soft/wecom-aibot-mcp', '--channel'] }
    : { command: 'node', args: [path.join(__dirname, 'bin.js'), '--channel'] };

  if (mode === 'channel-only') {
    // Channel-only 模式：必须通过 MCP_URL 指定远程地址
    const mcpUrl = process.env.MCP_URL;
    if (!mcpUrl) {
      console.log('[config] ❌ Channel-only 模式需要指定 MCP_URL');
      console.log('[config] 请设置环境变量: MCP_URL=http://远程IP:18963');
      return { upgraded: false, previousVersion };
    }
    const channelEnv: any = { MCP_URL: mcpUrl.replace(/\/+$/, '') };
    const authToken = getAuthToken();
    if (authToken) {
      channelEnv.MCP_AUTH_TOKEN = authToken;
    }
    claudeConfig.mcpServers['wecom-aibot-channel'] = {
      command: channelCmd.command,
      args: channelCmd.args,
      env: channelEnv,
    };
    console.log(`[config] Channel-only 模式：Channel MCP 已配置`);
  } else {
    // full 模式：同时写入 HTTP MCP 和 Channel MCP 配置
    claudeConfig.mcpServers['wecom-aibot'] = {
      type: 'http',
      url: 'http://127.0.0.1:18963/mcp',
    };
    // Channel MCP 配置：保留已有的自定义 MCP_URL（如 channel-only 安装时写入的远程地址）
    const existingChannel = claudeConfig.mcpServers['wecom-aibot-channel'];
    const existingMcpUrl = existingChannel?.env?.MCP_URL;
    const isRemote = existingMcpUrl && !existingMcpUrl.startsWith('http://127.0.0.1');
    const channelMcpUrl = isRemote ? existingMcpUrl : 'http://127.0.0.1:18963';
    const channelEnvFull: any = { MCP_URL: channelMcpUrl };
    // 保留已有的 MCP_AUTH_TOKEN（远程安装时写入），或从 server.json 读取
    const existingToken = existingChannel?.env?.MCP_AUTH_TOKEN;
    if (isRemote) {
      const token = existingToken || getAuthToken();
      if (token) channelEnvFull.MCP_AUTH_TOKEN = token;
    }
    claudeConfig.mcpServers['wecom-aibot-channel'] = {
      command: channelCmd.command,
      args: channelCmd.args,
      env: channelEnvFull,
    };
    console.log(`[config] full 模式：Channel MCP 使用本地路径`);
  }
  fs.writeFileSync(CLAUDE_CONFIG_FILE, JSON.stringify(claudeConfig, null, 2));
  console.log('[config] 已写入 MCP 配置到 ~/.claude.json');

  // 2. 强制写入权限配置和 Hook
  writeMcpPermissions();
  console.log('[config] 已写入权限配置到 ~/.claude/settings.local.json');

  // 3. 写入版本号
  writeVersionFile(mode);
  console.log(`[config] 已记录版本号: ${VERSION}`);

  return { upgraded, previousVersion };
}

// 远程安装向导（交互式输入 URL + Token）
export async function runRemoteInstallWizard(): Promise<'remote' | 'remote-channel' | 'server' | null> {
  const rl = createRL();
  const CLAUDE_CONFIG_FILE = path.join(os.homedir(), '.claude.json');

  try {
    // 检测本机是否有 ~/.claude.json（判断是 Client 还是 Server）
    const hasClaudeConfig = fs.existsSync(CLAUDE_CONFIG_FILE);

    if (!hasClaudeConfig) {
      // Server 安装模式：本机无 ~/.claude.json，作为远程服务器
      console.log('\n检测到本机无 ~/.claude.json → Server 安装模式\n');
      console.log('  Server 端只需启动 HTTP MCP Server，不写入 MCP 配置');
      console.log('  Client 端在其他机器上安装\n');

      const confirm = await question(rl, '确认作为远程 Server 安装？(y/N): ');
      if (confirm.toLowerCase() !== 'y') {
        console.log('[config] 已取消');
        return null;
      }

      // Server 不写入 ~/.claude.json，只提示启动命令
      console.log('\n─────────────────────────────────────');
      console.log('Server 安装完成！');
      console.log('  启动命令: npx @vrs-soft/wecom-aibot-mcp --start');
      console.log('  或者:     npm run start:http');
      console.log('─────────────────────────────────────\n');
      console.log('[config] Client 端请在其他机器运行安装程序连接本服务器\n');
      return 'server';
    }

    // Client 安装模式：本机有 ~/.claude.json，作为客户端
    // 远程模式 = HTTP/Channel 完全分离：本地只装 Client 配置，daemon 在远端
    console.log('\n检测到本机有 ~/.claude.json → Client 安装模式\n');
    console.log('  请选择连接远程服务器的方式：\n');
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
        const docTag = robot.doc_mcp_url ? ' [文档✅]' : '';
        console.log(`  ${idx + 1}. ${robot.name} (Bot ID: ${robot.botId.slice(0, 12)}...)${docTag}`);
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

    // 第六步：目标用户（默认联系人）
    // 修改场景：询问是否要重新识别；选 Y 则连接 bot 等待用户消息（与 --add 一致）；选 N 保持原值
    let targetUserId = targetRobot?.targetUserId || '';
    if (targetRobot) {
      console.log(`\n当前默认联系人（targetUserId）: ${targetUserId || '（未设置）'}`);
      const changeContact = await question(rl, '是否重新识别？(y/N): ');
      if (changeContact.toLowerCase() === 'y') {
        // 临时连接 bot 等待用户消息以识别 userid
        console.log('\n[config] 正在连接企业微信验证凭证...');
        const { initClient } = await import('./client.js');
        const tmpClient = initClient(botId, secret, 'placeholder', 'config-detect');

        // 等待连接（最多10秒）
        const connected = await new Promise<boolean>((resolve) => {
          const start = Date.now();
          const iv = setInterval(() => {
            if (tmpClient.isConnected()) { clearInterval(iv); resolve(true); }
            else if (Date.now() - start > 10000) { clearInterval(iv); resolve(false); }
          }, 500);
        });

        if (!connected) {
          console.log('[config] ❌ 连接失败（Bot ID/Secret 可能有误），保持原默认联系人');
          tmpClient.disconnect();
        } else {
          const detectedUserId = await detectUserIdFromMessage(tmpClient, 180);
          tmpClient.disconnect();
          if (detectedUserId) {
            targetUserId = detectedUserId;
            console.log(`[config] ✅ 默认联系人已更新: ${targetUserId}`);
          } else {
            console.log('[config] 未识别到用户消息，保持原默认联系人');
          }
        }
      } else {
        console.log('[config] 保持原默认联系人');
      }
    }

    // 第七步：确认
    console.log('\n─────────────────────────────────────');
    console.log('配置确认：');
    console.log(`  机器人名称:   ${robotName}`);
    console.log(`  Bot ID:       ${botId}`);
    console.log(`  Secret:       ${secret.slice(0, 8)}...${secret.slice(-4)}`);
    console.log(`  文档 MCP:     ${docMcpUrl ? '✅ 已配置' : '（未配置）'}`);
    console.log(`  默认联系人:   ${targetUserId || '（将通过消息自动识别）'}`);
    console.log('─────────────────────────────────────\n');

    const confirm = await question(rl, '确认配置？(Y/n): ');

    if (confirm.toLowerCase() === 'n') {
      console.log('[config] 配置已取消');
      process.exit(0);
    }

    // 返回最终配置
    const config: WecomConfig = {
      botId,
      secret,
      targetUserId,  // 修改时保留 / 已变更，新建时为空（稍后识别）
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
 * 2. 保存的配置文件（~/.wecom-aibot-mcp/robot-*.json）
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
