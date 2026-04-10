/**
 * 项目配置管理模块
 *
 * 支持全局配置 + 项目特定配置的混合模式：
 * - 项目配置（可选）：{项目}/.claude/wecom-aibot/config.json
 * - 全局配置（默认）：~/.claude.json 中的 mcpServers.wecom-aibot.env
 *
 * 配置优先级：项目配置 > 全局配置
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface ProjectConfig {
  botId: string;
  secret: string;
  defaultUser: string;
  nameTag?: string;
}

// 微信模式配置接口
export interface WechatModeConfig {
  robotName?: string;
  wechatMode: boolean;
  autoApprove?: boolean;
}

// 配置文件路径
const CLAUDE_CONFIG_FILE = path.join(os.homedir(), '.claude.json');
const PROJECT_CONFIG_SUBDIR = '.claude/wecom-aibot';
const PROJECT_CONFIG_FILE = 'config.json';
const WECHAT_MODE_CONFIG_FILE = 'wecom-aibot.json';

/**
 * 获取项目配置文件路径
 */
export function getProjectConfigPath(projectDir: string): string {
  return path.join(projectDir, PROJECT_CONFIG_SUBDIR, PROJECT_CONFIG_FILE);
}

/**
 * 加载项目特定配置
 *
 * @param projectDir 项目目录路径
 * @returns 项目配置或 null
 */
export function loadProjectConfig(projectDir: string): ProjectConfig | null {
  const configPath = getProjectConfigPath(projectDir);

  if (!fs.existsSync(configPath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(configPath, 'utf-8');
    const config = JSON.parse(content);

    // 验证必需字段
    if (!config.botId || !config.secret || !config.defaultUser) {
      console.error(`[project-config] 项目配置缺少必需字段: ${configPath}`);
      return null;
    }

    return {
      botId: config.botId,
      secret: config.secret,
      defaultUser: config.defaultUser,
      nameTag: config.nameTag,
    };
  } catch (err) {
    console.error(`[project-config] 解析项目配置失败: ${configPath}`, err);
    return null;
  }
}

/**
 * 保存项目配置
 *
 * @param projectDir 项目目录路径
 * @param config 项目配置
 */
export function saveProjectConfig(projectDir: string, config: ProjectConfig): void {
  const configDir = path.join(projectDir, PROJECT_CONFIG_SUBDIR);
  const configPath = getProjectConfigPath(projectDir);

  // 确保目录存在
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  console.log(`[project-config] 已保存项目配置: ${configPath}`);
}

/**
 * 删除项目配置
 *
 * @param projectDir 项目目录路径
 */
export function deleteProjectConfig(projectDir: string): void {
  const configPath = getProjectConfigPath(projectDir);

  if (fs.existsSync(configPath)) {
    fs.unlinkSync(configPath);
    console.log(`[project-config] 已删除项目配置: ${configPath}`);
  }
}

/**
 * 获取微信模式配置文件路径
 */
export function getWechatModeConfigPath(projectDir: string): string {
  return path.join(projectDir, '.claude', WECHAT_MODE_CONFIG_FILE);
}

/**
 * 加载微信模式配置
 */
export function loadWechatModeConfig(projectDir: string): WechatModeConfig | null {
  const configPath = getWechatModeConfigPath(projectDir);

  if (!fs.existsSync(configPath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(configPath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/**
 * 更新微信模式配置
 *
 * @param projectDir 项目目录路径
 * @param updates 要更新的字段
 */
export function updateWechatModeConfig(projectDir: string, updates: Partial<WechatModeConfig>): void {
  const configPath = getWechatModeConfigPath(projectDir);
  const configDir = path.dirname(configPath);

  // 确保目录存在
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }

  // 读取现有配置
  let config: WechatModeConfig = { wechatMode: false };
  if (fs.existsSync(configPath)) {
    try {
      const content = fs.readFileSync(configPath, 'utf-8');
      config = JSON.parse(content);
    } catch {
      // ignore
    }
  }

  // 合并更新
  const newConfig = { ...config, ...updates };
  fs.writeFileSync(configPath, JSON.stringify(newConfig, null, 2));
  console.log(`[project-config] 已更新微信模式配置: ${configPath}`);
}

/**
 * 加载全局配置（从 ~/.claude.json）
 *
 * @returns 全局配置或 null
 */
export function loadGlobalConfig(): ProjectConfig | null {
  try {
    if (!fs.existsSync(CLAUDE_CONFIG_FILE)) {
      return null;
    }

    const content = fs.readFileSync(CLAUDE_CONFIG_FILE, 'utf-8');
    const claudeConfig = JSON.parse(content);
    const mcpConfig = claudeConfig.mcpServers?.['wecom-aibot'];

    if (!mcpConfig?.env) {
      return null;
    }

    const { WECOM_BOT_ID, WECOM_SECRET, WECOM_TARGET_USER } = mcpConfig.env;

    if (!WECOM_BOT_ID || !WECOM_SECRET || !WECOM_TARGET_USER) {
      return null;
    }

    return {
      botId: WECOM_BOT_ID,
      secret: WECOM_SECRET,
      defaultUser: WECOM_TARGET_USER,
    };
  } catch (err) {
    console.error('[project-config] 加载全局配置失败:', err);
    return null;
  }
}

/**
 * 获取配置（按优先级查找）
 *
 * 优先级：
 * 1. 项目配置：{项目}/.claude/wecom-aibot/config.json
 * 2. 全局配置：~/.claude.json
 *
 * @param projectDir 项目目录路径（可选）
 * @returns 配置或 null
 */
export function getConfig(projectDir?: string): ProjectConfig | null {
  // 1. 尝试项目配置
  if (projectDir) {
    const projectConfig = loadProjectConfig(projectDir);
    if (projectConfig) {
      console.log(`[project-config] 使用项目配置: ${projectDir}`);
      return projectConfig;
    }
  }

  // 2. 回退全局配置
  const globalConfig = loadGlobalConfig();
  if (globalConfig) {
    console.log('[project-config] 使用全局配置');
    return globalConfig;
  }

  return null;
}

/**
 * 检查项目是否已配置
 *
 * @param projectDir 项目目录路径
 * @returns 是否已配置
 */
export function hasProjectConfig(projectDir: string): boolean {
  return fs.existsSync(getProjectConfigPath(projectDir));
}

/**
 * 获取配置来源
 *
 * @param projectDir 项目目录路径
 * @returns 'project' | 'global' | 'none'
 */
export function getConfigSource(projectDir?: string): 'project' | 'global' | 'none' {
  if (projectDir && hasProjectConfig(projectDir)) {
    return 'project';
  }

  if (loadGlobalConfig()) {
    return 'global';
  }

  return 'none';
}

/**
 * 列出所有已配置的项目
 *
 * 遍历可能的父目录查找项目配置
 *
 * @param searchDirs 要搜索的目录列表
 * @returns 已配置的项目列表
 */
export function listConfiguredProjects(searchDirs: string[] = []): Array<{
  projectDir: string;
  config: ProjectConfig;
}> {
  const results: Array<{ projectDir: string; config: ProjectConfig }> = [];

  for (const dir of searchDirs) {
    if (hasProjectConfig(dir)) {
      const config = loadProjectConfig(dir);
      if (config) {
        results.push({ projectDir: dir, config });
      }
    }
  }

  return results;
}

/**
 * 验证配置是否有效
 *
 * @param config 配置对象
 * @returns 是否有效
 */
export function validateConfig(config: Partial<ProjectConfig>): boolean {
  return !!(config.botId && config.secret && config.defaultUser);
}

/**
 * 获取项目 settings.json 路径
 */
export function getProjectSettingsPath(projectDir: string): string {
  return path.join(projectDir, '.claude', 'settings.json');
}

/**
 * PermissionRequest hook 配置
 */
const PERMISSION_HOOK = {
  matcher: '',
  hooks: [{ type: 'command', command: '~/.wecom-aibot-mcp/permission-hook.sh' }],
};

/**
 * 添加 PermissionRequest hook 到项目 settings.json
 */
export function addPermissionHook(projectDir: string): void {
  const settingsPath = getProjectSettingsPath(projectDir);
  const settingsDir = path.dirname(settingsPath);

  // 确保目录存在
  if (!fs.existsSync(settingsDir)) {
    fs.mkdirSync(settingsDir, { recursive: true });
  }

  // 读取现有配置
  let settings: Record<string, unknown> = {};
  if (fs.existsSync(settingsPath)) {
    try {
      const content = fs.readFileSync(settingsPath, 'utf-8');
      settings = JSON.parse(content);
    } catch {
      // ignore
    }
  }

  // 添加 hooks.PermissionRequest
  if (!settings.hooks) {
    settings.hooks = {};
  }
  (settings.hooks as Record<string, unknown>).PermissionRequest = [PERMISSION_HOOK];

  // 写入配置
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  console.log(`[project-config] 已添加 PermissionRequest hook: ${settingsPath}`);
}

/**
 * 删除 PermissionRequest hook 从项目 settings.json
 */
export function removePermissionHook(projectDir: string): void {
  const settingsPath = getProjectSettingsPath(projectDir);

  if (!fs.existsSync(settingsPath)) {
    return;
  }

  try {
    const content = fs.readFileSync(settingsPath, 'utf-8');
    const settings = JSON.parse(content);

    // 删除 hooks.PermissionRequest
    if (settings.hooks && (settings.hooks as Record<string, unknown>).PermissionRequest) {
      delete (settings.hooks as Record<string, unknown>).PermissionRequest;

      // 如果 hooks 为空，删除整个 hooks 字段
      if (Object.keys(settings.hooks as Record<string, unknown>).length === 0) {
        delete settings.hooks;
      }

      // 写入配置
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
      console.log(`[project-config] 已删除 PermissionRequest hook: ${settingsPath}`);
    }
  } catch {
    // ignore
  }
}