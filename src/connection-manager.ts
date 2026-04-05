/**
 * 连接管理模块
 *
 * 管理微信机器人的 WebSocket 连接：
 * - 支持多项目/多机器人同时连接
 * - 按需建立连接（enter_headless_mode）
 * - 自动重连（断线时）
 * - 释放连接（exit_headless_mode）
 * - 机器人占用检查（跨进程）
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { WecomClient } from './client.js';
import { listAllRobots } from './config-wizard.js';
import { checkRobotOccupied as checkRobotOccupiedGlobal } from './headless-state.js';

// 机器人配置
interface RobotConfig {
  name: string;
  botId: string;
  secret: string;
  targetUserId: string;
}

// 连接管理器状态
interface ConnectionState {
  projectDir: string;      // 项目目录
  robotName: string;       // 机器人名称
  client: WecomClient;     // WebSocket 客户端
  connectedAt: number;     // 连接时间
}

// 多连接池：按 projectDir 存储连接
const connectionPool: Map<string, ConnectionState> = new Map();

// 反向索引：robotName -> projectDir（当前进程内的连接状态）
const robotUsage: Map<string, string> = new Map();

const CONFIG_DIR = path.join(os.homedir(), '.wecom-aibot-mcp');

/**
 * 根据机器人名称查找配置
 */
function findRobotConfig(robotName: string): RobotConfig | null {
  const robots = listAllRobots();
  const robot = robots.find(r =>
    r.name === robotName || r.botId === robotName || r.name.includes(robotName)
  );

  if (!robot) return null;

  // 先检查默认配置
  const defaultConfigPath = path.join(CONFIG_DIR, 'config.json');
  if (robot.isDefault && fs.existsSync(defaultConfigPath)) {
    const config = JSON.parse(fs.readFileSync(defaultConfigPath, 'utf-8'));
    return {
      name: robot.name,
      botId: robot.botId,
      secret: config.secret,
      targetUserId: robot.targetUserId,
    };
  }

  // 尝试按文件名查找
  const files = fs.readdirSync(CONFIG_DIR).filter(f => f.startsWith('robot-') && f.endsWith('.json'));
  for (const file of files) {
    try {
      const config = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, file), 'utf-8'));
      if (config.nameTag === robotName || config.botId === robot.botId) {
        return {
          name: config.nameTag || robot.name,
          botId: config.botId,
          secret: config.secret,
          targetUserId: config.targetUserId,
        };
      }
    } catch {
      // ignore
    }
  }

  return null;
}

/**
 * 等待连接建立
 */
function waitForConnection(client: WecomClient, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const startTime = Date.now();
    const checkInterval = setInterval(() => {
      if (client.isConnected()) {
        clearInterval(checkInterval);
        resolve(true);
      } else if (Date.now() - startTime > timeoutMs) {
        clearInterval(checkInterval);
        resolve(false);
      }
    }, 500);
  });
}

/**
 * 检查机器人是否被占用（跨进程 + 当前进程）
 *
 * 先检查当前进程内的连接，再检查全局 headless 状态
 */
export function isRobotOccupied(robotName: string, excludeProjectDir?: string): boolean {
  // 1. 检查当前进程内的连接
  const occupiedByLocal = robotUsage.get(robotName);
  if (occupiedByLocal && occupiedByLocal !== excludeProjectDir) {
    return true;
  }

  // 2. 检查全局 headless 状态（跨进程）
  const result = checkRobotOccupiedGlobal(robotName, excludeProjectDir);
  return result.occupied;
}

/**
 * 获取占用机器人的项目（跨进程 + 当前进程）
 */
export function getRobotOccupiedBy(robotName: string): string | undefined {
  // 1. 先检查当前进程内的连接
  const local = robotUsage.get(robotName);
  if (local) return local;

  // 2. 检查全局 headless 状态
  const result = checkRobotOccupiedGlobal(robotName);
  return result.by?.projectDir;
}

/**
 * 连接到指定机器人（为指定项目）
 */
export async function connectRobot(
  projectDir: string,
  robotName: string
): Promise<{
  success: boolean;
  client?: WecomClient;
  error?: string;
}> {
  // 检查机器人是否被占用
  if (isRobotOccupied(robotName, projectDir)) {
    const occupiedBy = getRobotOccupiedBy(robotName);
    return {
      success: false,
      error: `机器人「${robotName}」已被项目 ${occupiedBy} 占用`,
    };
  }

  const robot = await findRobotConfig(robotName);

  if (!robot) {
    return {
      success: false,
      error: `未找到机器人配置: ${robotName}`,
    };
  }

  // 如果该项目已有连接，先断开
  const existingState = connectionPool.get(projectDir);
  if (existingState) {
    existingState.client.disconnect();
    robotUsage.delete(existingState.robotName);
  }

  // 建立新连接
  const client = new WecomClient(robot.botId, robot.secret, robot.targetUserId);
  client.connect();

  const connected = await waitForConnection(client, 10000);

  if (!connected) {
    return {
      success: false,
      error: `连接失败，请检查机器人配置`,
    };
  }

  // 存储到连接池
  const state: ConnectionState = {
    projectDir,
    robotName: robot.name,
    client,
    connectedAt: Date.now(),
  };

  connectionPool.set(projectDir, state);
  robotUsage.set(robot.name, projectDir);

  console.log(`[connection] 已连接机器人: ${robot.name} (项目: ${projectDir})`);

  return {
    success: true,
    client,
  };
}

/**
 * 断开指定项目的连接
 */
export function disconnectRobot(projectDir: string): void {
  const state = connectionPool.get(projectDir);
  if (state) {
    state.client.disconnect();
    robotUsage.delete(state.robotName);
    connectionPool.delete(projectDir);
    console.log(`[connection] 已断开机器人: ${state.robotName} (项目: ${projectDir})`);
  }
}

/**
 * 获取指定项目的客户端（自动重连）
 */
export async function getClient(projectDir: string): Promise<WecomClient | null> {
  const state = connectionPool.get(projectDir);

  if (!state) {
    return null;
  }

  // 如果已连接，直接返回
  if (state.client.isConnected()) {
    return state.client;
  }

  // 断开了，尝试重连
  const robot = await findRobotConfig(state.robotName);
  if (robot) {
    console.log(`[connection] 重连机器人: ${robot.name} (项目: ${projectDir})`);
    state.client = new WecomClient(robot.botId, robot.secret, robot.targetUserId);
    state.client.connect();

    const connected = await waitForConnection(state.client, 5000);
    if (connected) {
      console.log(`[connection] 重连成功: ${robot.name}`);
      return state.client;
    } else {
      console.log(`[connection] 重连失败: ${robot.name}`);
      return null;
    }
  }

  return null;
}

/**
 * 获取当前项目的机器人名称
 */
export function getCurrentRobotName(projectDir: string): string | null {
  return connectionPool.get(projectDir)?.robotName || null;
}

/**
 * 检查指定项目是否已连接
 */
export function isConnected(projectDir: string): boolean {
  const state = connectionPool.get(projectDir);
  return state?.client?.isConnected() || false;
}

/**
 * 获取所有连接状态
 */
export function getAllConnectionStates(): Array<{
  projectDir: string;
  robotName: string;
  connected: boolean;
  connectedAt: number;
}> {
  const results: Array<{
    projectDir: string;
    robotName: string;
    connected: boolean;
    connectedAt: number;
  }> = [];

  for (const [projectDir, state] of connectionPool) {
    results.push({
      projectDir,
      robotName: state.robotName,
      connected: state.client.isConnected(),
      connectedAt: state.connectedAt,
    });
  }

  return results;
}

/**
 * 获取连接状态（兼容旧 API，返回第一个连接）
 */
export function getConnectionState(): {
  connected: boolean;
  robotName: string | null;
  connectedAt: number | null;
} {
  // 遍历连接池，返回第一个活跃连接
  for (const [_, state] of connectionPool) {
    if (state.client.isConnected()) {
      return {
        connected: true,
        robotName: state.robotName,
        connectedAt: state.connectedAt,
      };
    }
  }

  return {
    connected: false,
    robotName: null,
    connectedAt: null,
  };
}