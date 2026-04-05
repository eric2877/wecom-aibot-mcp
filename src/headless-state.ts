/**
 * Headless 状态管理模块
 *
 * 管理微信模式的进入/退出状态，支持：
 * - 按进程 PID 区分状态文件
 * - 状态文件包含 projectDir 用于 ClientPool 查找
 * - 项目级 Hook 配置自动写入/清除
 *
 * 状态文件路径：~/.wecom-aibot-mcp/headless-{PID}
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface HeadlessState {
  projectDir: string;    // 项目目录路径
  timestamp: number;     // 进入时间戳
  agentName?: string;    // 智能体名称
  autoApprove?: boolean; // 智能代批开关（默认 true）
}

// 配置目录
const CONFIG_DIR = path.join(os.homedir(), '.wecom-aibot-mcp');

// 项目 settings.json 路径
const PROJECT_SETTINGS_SUBDIR = '.claude';

// Hook 脚本路径
const HOOK_SCRIPT_PATH = path.join(CONFIG_DIR, 'permission-hook.sh');

/**
 * 确保配置目录存在
 */
function ensureConfigDir(): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

/**
 * 获取当前进程的 headless 状态文件路径
 */
export function getHeadlessFilePath(pid?: number): string {
  const processId = pid || process.pid;
  return path.join(CONFIG_DIR, `headless-${processId}`);
}

/**
 * 进入 headless 模式
 *
 * 1. 清理旧的孤儿状态文件
 * 2. 写入 headless 状态文件（含 projectDir）
 * 3. 写入项目级 Hook 配置
 *
 * @param projectDir 项目目录路径
 * @param agentName 智能体名称（可选）
 */
export function enterHeadlessMode(projectDir: string, agentName?: string): HeadlessState {
  ensureConfigDir();

  // 0. 清理旧的孤儿状态文件（服务重启后 PID 变化）
  cleanupOrphanFiles();

  const state: HeadlessState = {
    projectDir,
    timestamp: Date.now(),
    agentName,
  };

  // 1. 写入状态文件
  const stateFilePath = getHeadlessFilePath();
  fs.writeFileSync(stateFilePath, JSON.stringify(state, null, 2));
  console.log(`[headless] 已进入微信模式: ${stateFilePath}`);

  // 2. 写入项目级 Hook 配置
  configureProjectHook(projectDir, agentName);

  return state;
}

/**
 * 退出 headless 模式
 *
 * 1. 删除 headless 状态文件
 * 2. 清除项目级 Hook 配置
 *
 * @returns 退出前的状态或 null
 */
export function exitHeadlessMode(): HeadlessState | null {
  const state = loadHeadlessState();

  if (!state) {
    console.log('[headless] 未在微信模式');
    return null;
  }

  // 1. 删除状态文件
  const stateFilePath = getHeadlessFilePath();
  if (fs.existsSync(stateFilePath)) {
    fs.unlinkSync(stateFilePath);
    console.log(`[headless] 已删除状态文件: ${stateFilePath}`);
  }

  // 2. 清除项目级 Hook 配置
  clearProjectHook(state.projectDir);

  return state;
}

/**
 * 更新 autoApprove 设置
 *
 * @param enabled 是否启用智能代批
 * @returns 更新后的状态或 null
 */
export function setAutoApprove(enabled: boolean): HeadlessState | null {
  const state = loadHeadlessState();

  if (!state) {
    return null;
  }

  state.autoApprove = enabled;

  // 写入状态文件
  const stateFilePath = getHeadlessFilePath();
  fs.writeFileSync(stateFilePath, JSON.stringify(state, null, 2));
  console.log(`[headless] 已${enabled ? '启用' : '禁用'}智能代批`);

  return state;
}

/**
 * 加载当前进程的 headless 状态
 *
 * @returns HeadlessState 或 null
 */
export function loadHeadlessState(): HeadlessState | null {
  const stateFilePath = getHeadlessFilePath();

  if (!fs.existsSync(stateFilePath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(stateFilePath, 'utf-8');
    return JSON.parse(content);
  } catch (err) {
    console.error(`[headless] 解析状态文件失败: ${stateFilePath}`, err);
    return null;
  }
}

/**
 * 检查是否在 headless 模式
 */
export function isHeadlessMode(): boolean {
  return fs.existsSync(getHeadlessFilePath());
}

/**
 * 配置项目级 Hook
 *
 * 写入 {项目}/.claude/settings.json
 */
function configureProjectHook(projectDir: string, agentName?: string): void {
  const settingsDir = path.join(projectDir, PROJECT_SETTINGS_SUBDIR);
  const settingsPath = path.join(settingsDir, 'settings.json');

  // 确保目录存在
  if (!fs.existsSync(settingsDir)) {
    fs.mkdirSync(settingsDir, { recursive: true });
  }

  // 读取现有配置
  let settings: any = {};
  if (fs.existsSync(settingsPath)) {
    try {
      const content = fs.readFileSync(settingsPath, 'utf-8');
      settings = JSON.parse(content);
    } catch (err) {
      console.error(`[headless] 读取 settings.json 失败: ${settingsPath}`, err);
    }
  }

  // 设置 PermissionRequest hook
  if (!settings.hooks) {
    settings.hooks = {};
  }

  settings.hooks['PermissionRequest'] = [
    {
      matcher: '',
      hooks: [
        {
          type: 'command',
          command: HOOK_SCRIPT_PATH,
          timeout: 600,
        },
      ],
    },
  ];

  // 写入配置
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  console.log(`[headless] 已配置项目 Hook: ${settingsPath}`);
}

/**
 * 清除项目级 Hook 配置
 *
 * 从 {项目}/.claude/settings.json 删除 hooks 字段
 */
function clearProjectHook(projectDir: string): void {
  const settingsPath = path.join(projectDir, PROJECT_SETTINGS_SUBDIR, 'settings.json');

  if (!fs.existsSync(settingsPath)) {
    return;
  }

  try {
    const content = fs.readFileSync(settingsPath, 'utf-8');
    const settings = JSON.parse(content);

    if (settings.hooks && settings.hooks['PermissionRequest']) {
      delete settings.hooks['PermissionRequest'];

      // 如果 hooks 对象为空，删除整个 hooks 字段
      if (Object.keys(settings.hooks).length === 0) {
        delete settings.hooks;
      }

      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
      console.log(`[headless] 已清除项目 Hook: ${settingsPath}`);
    }
  } catch (err) {
    console.error(`[headless] 清除项目 Hook 失败: ${settingsPath}`, err);
  }
}

/**
 * 清理所有孤儿状态文件及其 Hook 配置
 *
 * 用于 MCP Server 启动时清理残留状态
 */
export function clearAllProjectHooks(): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    return;
  }

  try {
    const files = fs.readdirSync(CONFIG_DIR);
    const headlessFiles = files.filter(f => f.startsWith('headless-'));

    for (const file of headlessFiles) {
      const pid = parseInt(file.replace('headless-', ''), 10);

      // 检查进程是否存在
      try {
        process.kill(pid, 0);
        // 进程存在，不清理
      } catch {
        // 进程不存在，读取状态并清理 Hook
        const filePath = path.join(CONFIG_DIR, file);
        try {
          const content = fs.readFileSync(filePath, 'utf-8');
          const state = JSON.parse(content);
          if (state.projectDir) {
            clearProjectHook(state.projectDir);
            console.log(`[headless] 已清理残留 Hook: ${state.projectDir}`);
          }
        } catch (e) {
          // 解析失败，忽略
        }

        // 清理状态文件
        fs.unlinkSync(filePath);
        console.log(`[headless] 清理孤儿状态文件: ${file} (PID ${pid} 已不存在)`);
      }
    }
  } catch (err) {
    console.error('[headless] 清理孤儿文件失败:', err);
  }
}

/**
 * 清理孤儿状态文件
 *
 * 检查进程是否存在，清理已终止进程的状态文件
 */
export function cleanupOrphanFiles(): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    return;
  }

  try {
    const files = fs.readdirSync(CONFIG_DIR);
    const headlessFiles = files.filter(f => f.startsWith('headless-'));

    for (const file of headlessFiles) {
      const pid = parseInt(file.replace('headless-', ''), 10);

      // 检查进程是否存在
      try {
        process.kill(pid, 0);
        // 进程存在，不清理
      } catch {
        // 进程不存在，清理文件
        const filePath = path.join(CONFIG_DIR, file);
        fs.unlinkSync(filePath);
        console.log(`[headless] 清理孤儿状态文件: ${file} (PID ${pid} 已不存在)`);
      }
    }
  } catch (err) {
    console.error('[headless] 清理孤儿文件失败:', err);
  }
}

/**
 * 获取所有 headless 状态
 *
 * @returns 所有活跃的 headless 状态列表
 */
export function getAllHeadlessStates(): Array<{
  pid: number;
  state: HeadlessState;
}> {
  const results: Array<{ pid: number; state: HeadlessState }> = [];

  if (!fs.existsSync(CONFIG_DIR)) {
    return results;
  }

  try {
    const files = fs.readdirSync(CONFIG_DIR);
    const headlessFiles = files.filter(f => f.startsWith('headless-'));

    for (const file of headlessFiles) {
      const pid = parseInt(file.replace('headless-', ''), 10);
      const filePath = path.join(CONFIG_DIR, file);

      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const state = JSON.parse(content);
        results.push({ pid, state });
      } catch (err) {
        console.error(`[headless] 解析状态文件失败: ${filePath}`, err);
      }
    }
  } catch (err) {
    console.error('[headless] 获取所有状态失败:', err);
  }

  return results;
}