/**
 * ClientPool 模块
 *
 * 按 projectDir 缓存 WecomClient 实例，支持多项目同时使用不同机器人。
 *
 * 设计要点：
 * - 使用 Map 存储 client 实例，key 为 projectDir
 * - 同一项目的多个 session 共享 client
 * - 支持多机器人配置
 */

import { WecomClient } from './client.js';

export interface WecomConfig {
  botId: string;
  secret: string;
  defaultUser: string;
  nameTag?: string;
}

// ClientPool 存储
const clientPool = new Map<string, WecomClient>();
// key: projectDir

// 配置缓存（用于 getOrCreateClient 时查找配置）
const configCache = new Map<string, WecomConfig>();

/**
 * 获取或创建 WecomClient 实例
 *
 * 如果 client 不存在，会自动创建并连接
 *
 * @param projectDir 项目目录路径
 * @param config 机器人配置（可选，如果已缓存则不需要）
 * @returns WecomClient 实例
 */
export function getOrCreateClient(projectDir: string, config?: WecomConfig): WecomClient {
  let client = clientPool.get(projectDir);

  if (!client) {
    if (!config) {
      config = configCache.get(projectDir);
    }

    if (!config) {
      throw new Error(`项目 ${projectDir} 未配置机器人，请先配置`);
    }

    // 创建新 client
    client = new WecomClient(config.botId, config.secret, config.defaultUser, projectDir);
    client.connect();

    // 存入 pool
    clientPool.set(projectDir, client);
    configCache.set(projectDir, config);

    console.log(`[client-pool] 已创建 client: ${projectDir}`);
  }

  return client;
}

/**
 * 获取已存在的 client
 *
 * @param projectDir 项目目录路径
 * @returns WecomClient 实例或 undefined
 */
export function getClient(projectDir: string): WecomClient | undefined {
  return clientPool.get(projectDir);
}

/**
 * 获取所有 client 实例
 *
 * @returns WecomClient 数组
 */
export function getAllClients(): WecomClient[] {
  return Array.from(clientPool.values());
}

/**
 * 获取所有项目目录
 *
 * @returns projectDir 数组
 */
export function getAllProjectDirs(): string[] {
  return Array.from(clientPool.keys());
}

/**
 * 缓存项目配置
 *
 * 用于在没有 client 时也能获取配置
 *
 * @param projectDir 项目目录路径
 * @param config 机器人配置
 */
export function setConfig(projectDir: string, config: WecomConfig): void {
  configCache.set(projectDir, config);
}

/**
 * 获取缓存的项目配置
 *
 * @param projectDir 项目目录路径
 * @returns 配置或 undefined
 */
export function getConfig(projectDir: string): WecomConfig | undefined {
  return configCache.get(projectDir);
}

/**
 * 移除 client
 *
 * @param projectDir 项目目录路径
 */
export function removeClient(projectDir: string): void {
  const client = clientPool.get(projectDir);
  if (client) {
    client.disconnect();
    clientPool.delete(projectDir);
    console.log(`[client-pool] 已移除 client: ${projectDir}`);
  }
}

/**
 * 清空所有 client
 */
export function clearAll(): void {
  for (const client of clientPool.values()) {
    client.disconnect();
  }
  clientPool.clear();
  configCache.clear();
  console.log('[client-pool] 已清空所有 client');
}

/**
 * 获取 client 状态统计
 */
export function getStats(): {
  totalClients: number;
  connectedClients: number;
  projects: Array<{
    projectDir: string;
    connected: boolean;
    defaultUser: string;
  }>;
} {
  const projects = Array.from(clientPool.entries()).map(([projectDir, client]) => ({
    projectDir,
    connected: client.isConnected(),
    defaultUser: client.getDefaultTargetUser(),
  }));

  return {
    totalClients: clientPool.size,
    connectedClients: projects.filter(p => p.connected).length,
    projects,
  };
}