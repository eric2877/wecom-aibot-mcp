/**
 * 连接管理模块
 *
 * 管理微信机器人的 WebSocket 连接：
 * - 按 robotName 索引连接
 * - 支持多机器人同时连接
 * - 自动重连（断线时）
 * - 机器人占用检查（当前进程内）
 *
 * v2.0 架构变更：
 * - 不再使用 projectDir 作为 key
 * - 改用 robotName 作为唯一索引
 * - 集成消息总线（用户消息通过 SSE 推送）
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { WecomClient } from './client.js';
import { listAllRobots } from './config-wizard.js';

// 机器人配置
interface RobotConfig {
  name: string;
  botId: string;
  secret: string;
  targetUserId: string;
}

// 连接状态
interface ConnectionState {
  robotName: string;       // 机器人名称
  client: WecomClient;     // WebSocket 客户端
  connectedAt: number;     // 连接时间
  lastActive: number;      // 最后活跃时间戳（用于超时清理）
  agentName?: string;      // 智能体名称
  ccId?: string;           // 当前绑定的 ccId
}

// 连接池：robotName → ConnectionState
const connectionPool: Map<string, ConnectionState> = new Map();

// 空闲超时：30 分钟无活跃自动断开
const INACTIVE_TIMEOUT = 30 * 60 * 1000;

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

  // 搜索所有配置文件（config.json + robot-*.json）
  const allFiles = ['config.json', ...fs.readdirSync(CONFIG_DIR).filter(f => f.startsWith('robot-') && f.endsWith('.json'))];
  const files = allFiles.filter(f => fs.existsSync(path.join(CONFIG_DIR, f)));

  // 先按 botId 精确匹配找 secret
  for (const file of files) {
    try {
      const config = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, file), 'utf-8'));
      if (config.botId === robot.botId) {
        return {
          name: robot.name,
          botId: robot.botId,
          secret: config.secret,
          targetUserId: robot.targetUserId,
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
 * 检查机器人是否被占用（当前进程内）
 */
export function isRobotOccupied(robotName: string): boolean {
  return connectionPool.has(robotName);
}

/**
 * 获取占用机器人的智能体名称
 */
export function getRobotOccupiedBy(robotName: string): string | undefined {
  const state = connectionPool.get(robotName);
  return state?.agentName;
}

/**
 * 连接到指定机器人
 * 注意：MCP Server 启动时已自动连接所有机器人
 * 此函数主要用于：
 * 1. 更新机器人的 agentName
 * 2. 如果连接不存在，则创建新连接
 */
export async function connectRobot(
  robotName: string,
  agentName?: string
): Promise<{
  success: boolean;
  client?: WecomClient;
  error?: string;
}> {
  // 如果已有连接，直接更新 agentName 并返回
  const existingState = connectionPool.get(robotName);
  if (existingState) {
    if (agentName) {
      existingState.agentName = agentName;
    }
    return {
      success: true,
      client: existingState.client,
    };
  }

  const robot = await findRobotConfig(robotName);

  if (!robot) {
    return {
      success: false,
      error: `未找到机器人配置: ${robotName}`,
    };
  }

  // 建立新连接（传入 robotName 用于消息总线）
  const client = new WecomClient(robot.botId, robot.secret, robot.targetUserId, robot.name);

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
    robotName: robot.name,
    client,
    connectedAt: Date.now(),
    lastActive: Date.now(),
    agentName,
  };

  connectionPool.set(robot.name, state);

  console.log(`[connection] 已连接机器人: ${robot.name}`);

  return {
    success: true,
    client,
  };
}

/**
 * 断开指定机器人的连接
 */
export function disconnectRobot(robotName: string): void {
  const state = connectionPool.get(robotName);
  if (state) {
    state.client.disconnect();
    connectionPool.delete(robotName);
    console.log(`[connection] 已断开机器人: ${robotName}`);
  }
}

/**
 * 获取指定机器人的客户端（自动重连）
 */
export async function getClient(robotName: string): Promise<WecomClient | null> {
  const state = connectionPool.get(robotName);

  if (!state) {
    return null;
  }

  // 如果已连接，更新 lastActive 并返回
  if (state.client.isConnected()) {
    state.lastActive = Date.now();
    return state.client;
  }

  // 断开了，尝试重连
  const robot = await findRobotConfig(state.robotName);
  if (robot) {
    console.log(`[connection] 重连机器人: ${robot.name}`);
    state.client = new WecomClient(robot.botId, robot.secret, robot.targetUserId, robot.name);
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
 * 获取所有连接状态
 */
export function getAllConnectionStates(): Array<{
  robotName: string;
  connected: boolean;
  connectedAt: number;
  agentName?: string;
}> {
  const results: Array<{
    robotName: string;
    connected: boolean;
    connectedAt: number;
    agentName?: string;
  }> = [];

  for (const [robotName, state] of connectionPool) {
    results.push({
      robotName,
      connected: state.client.isConnected(),
      connectedAt: state.connectedAt,
      agentName: state.agentName,
    });
  }

  return results;
}

/**
 * 获取连接状态（返回第一个活跃连接）
 */
export function getConnectionState(): {
  connected: boolean;
  robotName: string | null;
  connectedAt: number | null;
} {
  for (const [robotName, state] of connectionPool) {
    if (state.client.isConnected()) {
      return {
        connected: true,
        robotName,
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

/**
 * 更新机器人的智能体名称
 */
export function updateAgentName(robotName: string, agentName: string): void {
  const state = connectionPool.get(robotName);
  if (state) {
    state.agentName = agentName;
  }
}

/**
 * 自动连接所有配置的机器人
 * 在 MCP Server 启动时调用
 */
export async function connectAllRobots(): Promise<void> {
  const robots = listAllRobots();

  if (robots.length === 0) {
    console.log('[connection] 未配置任何机器人');
    return;
  }

  console.log(`[connection] 自动连接 ${robots.length} 个机器人...`);

  for (const robot of robots) {
    // 检查是否已被占用
    if (isRobotOccupied(robot.name)) {
      console.log(`[connection] 跳过已占用的机器人: ${robot.name}`);
      continue;
    }

    const result = await connectRobot(robot.name);

    if (result.success) {
      console.log(`[connection] ✅ ${robot.name} 已连接`);
    } else {
      console.log(`[connection] ❌ ${robot.name} 连接失败: ${result.error}`);
    }
  }
}

/**
 * 清理空闲连接（30 分钟无活跃自动断开）
 * 每 5 分钟调用一次
 */
function cleanupIdleConnections(): void {
  const now = Date.now();
  for (const [robotName, state] of connectionPool) {
    if (now - state.lastActive > INACTIVE_TIMEOUT) {
      console.log(`[connection] 断开空闲机器人: ${robotName}（${Math.floor((now - state.lastActive) / 60000)} 分钟无活跃）`);
      state.client.disconnect();
      connectionPool.delete(robotName);
    }
  }
}

// 启动空闲连接清理定时器（5 分钟）
setInterval(cleanupIdleConnections, 5 * 60 * 1000).unref();