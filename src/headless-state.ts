/**
 * Headless 状态管理模块
 *
 * 状态存储在项目目录：{projectDir}/.claude/headless.json
 * 全局索引：~/.wecom-aibot-mcp/headless-index.json
 *
 * Hook 脚本直接检查 $(pwd)/.claude/headless.json
 * 无需 PID 查找，100% 准确匹配
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { logger } from './logger.js';

export interface HeadlessState {
  projectDir: string;    // 项目目录路径
  timestamp: number;     // 进入时间戳
  agentName?: string;    // 智能体名称
  autoApprove?: boolean; // 智能代批开关（默认 true）
  robotName?: string;    // 当前使用的机器人名称
}

// 配置目录
const CONFIG_DIR = path.join(os.homedir(), '.wecom-aibot-mcp');

// 全局索引文件
const HEADLESS_INDEX_FILE = path.join(CONFIG_DIR, 'headless-index.json');

// 项目状态文件路径
const PROJECT_STATE_FILE = 'headless.json';

// 注意：Hook 配置由 tools/index.ts 通过 project-config.ts 的函数统一管理
// PERMISSION_HOOK_SCRIPT_PATH 定义在 project-config.ts 中

/**
 * 确保配置目录存在
 */
function ensureConfigDir(): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

/**
 * 获取项目的 headless 状态文件路径
 */
export function getProjectHeadlessFile(projectDir: string): string {
  return path.join(projectDir, '.claude', PROJECT_STATE_FILE);
}

/**
 * 读取全局索引
 */
function readHeadlessIndex(): string[] {
  if (!fs.existsSync(HEADLESS_INDEX_FILE)) {
    return [];
  }
  try {
    const content = fs.readFileSync(HEADLESS_INDEX_FILE, 'utf-8');
    return JSON.parse(content);
  } catch {
    return [];
  }
}

/**
 * 写入全局索引
 */
function writeHeadlessIndex(projects: string[]): void {
  ensureConfigDir();
  fs.writeFileSync(HEADLESS_INDEX_FILE, JSON.stringify(projects, null, 2));
}

/**
 * 进入 headless 模式
 *
 * 1. 写入项目状态文件 {projectDir}/.claude/headless.json
 * 2. 添加到全局索引 ~/.wecom-aibot-mcp/headless-index.json
 * 3. 写入项目级 Hook 配置
 */
export function enterHeadlessMode(projectDir: string, agentName?: string, robotName?: string): HeadlessState {
  ensureConfigDir();

  const state: HeadlessState = {
    projectDir,
    timestamp: Date.now(),
    agentName,
    robotName,
    autoApprove: true,  // 默认启用智能审批
  };

  // 1. 写入项目状态文件
  const stateFilePath = getProjectHeadlessFile(projectDir);
  const stateDir = path.dirname(stateFilePath);

  if (!fs.existsSync(stateDir)) {
    fs.mkdirSync(stateDir, { recursive: true });
  }

  fs.writeFileSync(stateFilePath, JSON.stringify(state, null, 2));
  logger.log(`[headless] 已进入微信模式: ${stateFilePath}`);

  // 2. 添加到全局索引
  const index = readHeadlessIndex();
  if (!index.includes(projectDir)) {
    index.push(projectDir);
    writeHeadlessIndex(index);
  }

  // 3. Hook 配置由 tools/index.ts 的 enter_headless_mode 工具调用 addPermissionHook 管理

  return state;
}

/**
 * 退出 headless 模式
 *
 * 1. 删除项目状态文件
 * 2. 从全局索引移除
 * 3. 清除项目级 Hook 配置
 */
export function exitHeadlessMode(projectDir?: string): HeadlessState | null {
  // 如果未指定项目目录，使用当前目录
  const dir = projectDir || process.cwd();
  const state = loadHeadlessState(dir);

  if (!state) {
    logger.log('[headless] 未在微信模式');
    return null;
  }

  // 1. 删除项目状态文件
  const stateFilePath = getProjectHeadlessFile(state.projectDir);
  if (fs.existsSync(stateFilePath)) {
    fs.unlinkSync(stateFilePath);
    logger.log(`[headless] 已删除状态文件: ${stateFilePath}`);
  }

  // 2. 从全局索引移除
  const index = readHeadlessIndex();
  const newIndex = index.filter(p => p !== state.projectDir);
  writeHeadlessIndex(newIndex);

  // 3. Hook 配置由 tools/index.ts 的 exit_headless_mode 工具调用 removePermissionHook 管理

  return state;
}

/**
 * 更新 autoApprove 设置
 */
export function setAutoApprove(enabled: boolean, projectDir?: string): HeadlessState | null {
  const dir = projectDir || process.cwd();
  const state = loadHeadlessState(dir);

  if (!state) {
    return null;
  }

  state.autoApprove = enabled;

  // 写入状态文件
  const stateFilePath = getProjectHeadlessFile(state.projectDir);
  fs.writeFileSync(stateFilePath, JSON.stringify(state, null, 2));
  logger.log(`[headless] 已${enabled ? '启用' : '禁用'}智能代批`);

  return state;
}

/**
 * 加载指定项目的 headless 状态
 */
export function loadHeadlessState(projectDir?: string): HeadlessState | null {
  const dir = projectDir || process.cwd();
  const stateFilePath = getProjectHeadlessFile(dir);

  if (!fs.existsSync(stateFilePath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(stateFilePath, 'utf-8');
    return JSON.parse(content);
  } catch (err) {
    logger.error(`[headless] 解析状态文件失败: ${stateFilePath}`, err);
    return null;
  }
}

/**
 * 检查指定项目是否在 headless 模式
 */
export function isHeadlessMode(projectDir?: string): boolean {
  const dir = projectDir || process.cwd();
  return fs.existsSync(getProjectHeadlessFile(dir));
}

// 注意：configureProjectHook 和 clearProjectHook 已移除
// Hook 配置由 tools/index.ts 通过 project-config.ts 的函数统一管理

/**
 * 清理所有孤儿状态文件
 *
 * 扫描全局索引，检查每个项目的状态文件是否存在
 * 如果状态文件不存在，从索引中移除
 */
export function cleanupOrphanFiles(): void {
  ensureConfigDir();

  const index = readHeadlessIndex();
  const validProjects: string[] = [];

  for (const projectDir of index) {
    const stateFilePath = getProjectHeadlessFile(projectDir);

    if (fs.existsSync(stateFilePath)) {
      validProjects.push(projectDir);
    } else {
      // 状态文件不存在，仅从索引移除，Hook 清理由用户手动处理
      logger.log(`[headless] 清理孤儿项目: ${projectDir}`);
    }
  }

  // 更新索引
  if (validProjects.length !== index.length) {
    writeHeadlessIndex(validProjects);
  }
}

/**
 * 获取所有 headless 状态
 *
 * 从全局索引读取，返回所有活跃状态
 */
export function getAllHeadlessStates(): Array<{
  projectDir: string;
  state: HeadlessState;
}> {
  cleanupOrphanFiles();  // 先清理孤儿状态

  const index = readHeadlessIndex();
  const results: Array<{ projectDir: string; state: HeadlessState }> = [];

  for (const projectDir of index) {
    const state = loadHeadlessState(projectDir);
    if (state) {
      results.push({ projectDir, state });
    }
  }

  return results;
}

/**
 * 清理所有项目 Hook 配置（服务重启时）
 */
export function clearAllProjectHooks(): void {
  cleanupOrphanFiles();
}