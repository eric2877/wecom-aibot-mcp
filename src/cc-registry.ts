/**
 * ccId 注册表
 *
 * 管理 ~/.wecom-aibot-mcp/cc-registry.json
 * 维护 ccId → { robotName, lastActive, createdAt } 的映射
 *
 * 文件锁通过 .lock 文件实现（EEXIST 原子性）
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { atomicWriteFileSync } from './utils/atomic-write.js';
import { logWarn } from './connection-log.js';

const WARNING_MS = 10 * 24 * 60 * 60 * 1000;  // 10 天：过期前警告
const EXPIRY_MS  = 14 * 24 * 60 * 60 * 1000;  // 14 天：清理

// 心跳检测常量
const OFFLINE_THRESHOLD = 10 * 60 * 1000;  // 10 分钟无心跳视为离线
const NOTIFICATION_INTERVAL = 30 * 60 * 1000;  // 30 分钟最多通知一次

// 支持测试环境覆盖
let CONFIG_DIR = path.join(os.homedir(), '.wecom-aibot-mcp');
let REGISTRY_FILE = path.join(CONFIG_DIR, 'cc-registry.json');
let LOCK_FILE = path.join(CONFIG_DIR, 'cc-registry.lock');

/**
 * 设置配置目录（仅用于测试）
 */
export function setConfigDir(dir: string): void {
  CONFIG_DIR = dir;
  REGISTRY_FILE = path.join(CONFIG_DIR, 'cc-registry.json');
  LOCK_FILE = path.join(CONFIG_DIR, 'cc-registry.lock');
}

export interface CcRegistryEntry {
  robotName: string;
  lastActive: number;
  createdAt: number;
  lastNotified?: number;  // 最后发送离线通知时间（避免重复通知）
}

type Registry = Record<string, CcRegistryEntry>;

// ────────────────────────────────────────────
// 文件锁（基于 EEXIST 原子性）
// ────────────────────────────────────────────

function acquireLock(): boolean {
  try {
    fs.openSync(LOCK_FILE, 'wx');
    return true;
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw e;
  }
}

function releaseLock(): void {
  try { fs.unlinkSync(LOCK_FILE); } catch { /* ignore */ }
}

function withLock<T>(fn: () => T): T {
  const deadline = Date.now() + 3000;
  while (!acquireLock()) {
    if (Date.now() > deadline) throw new Error('cc-registry: 获取锁超时');
    // 自旋等待（锁持有时间极短）
    const start = Date.now();
    while (Date.now() - start < 50) { /* busy wait */ }
  }
  try {
    return fn();
  } finally {
    releaseLock();
  }
}

// ────────────────────────────────────────────
// 注册表 I/O
// ────────────────────────────────────────────

function readRegistry(): Registry {
  try {
    return JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf-8')) as Registry;
  } catch {
    return {};
  }
}

function writeRegistry(registry: Registry): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  atomicWriteFileSync(REGISTRY_FILE, JSON.stringify(registry, null, 2));
}

// ────────────────────────────────────────────
// 过期清理
// ────────────────────────────────────────────

/**
 * 内部清理：在已持锁的上下文中直接操作传入的 registry 对象。
 * 不获取锁，调用方负责锁安全。
 */
function pruneExpired(registry: Registry): boolean {
  const now = Date.now();
  let changed = false;
  for (const [ccId, entry] of Object.entries(registry)) {
    const inactive = now - entry.lastActive;
    if (inactive > EXPIRY_MS) {
      logWarn(`[cc-registry] 已清理过期 ccId "${ccId}" (robot: ${entry.robotName})，超过 14 天未活跃`);
      delete registry[ccId];
      changed = true;
    } else if (inactive > WARNING_MS) {
      logWarn(`[cc-registry] 警告：ccId "${ccId}" (robot: ${entry.robotName}) 已 10 天未活跃，4 天后将自动清理`);
    }
  }
  return changed;
}

/**
 * 公开接口：独立调用时使用（内部会获取锁）
 */
export function cleanupExpiredEntries(): void {
  withLock(() => {
    const registry = readRegistry();
    if (pruneExpired(registry)) writeRegistry(registry);
  });
}

// ────────────────────────────────────────────
// 公开 API
// ────────────────────────────────────────────

export type RegisterResult = 'registered' | 'renewed' | 'occupied';

/**
 * 注册 ccId
 * - 新 ccId → registered
 * - 已存在且 robotName 相同 → renewed（续期）
 * - 已存在且 robotName 不同 → occupied（被占用）
 */
export function registerCcId(ccId: string, robotName: string): RegisterResult {
  return withLock(() => {
    const registry = readRegistry();
    pruneExpired(registry);  // 已在锁内，不二次获取

    const existing = registry[ccId];
    if (existing) {
      if (existing.robotName === robotName) {
        // 同 ccId + 同 robotName → 续期
        existing.lastActive = Date.now();
        writeRegistry(registry);
        return 'renewed';
      } else {
        return 'occupied';
      }
    }

    registry[ccId] = {
      robotName,
      lastActive: Date.now(),
      createdAt: Date.now(),
    };
    writeRegistry(registry);
    return 'registered';
  });
}

/**
 * 注销 ccId
 */
export function unregisterCcId(ccId: string): void {
  withLock(() => {
    const registry = readRegistry();
    delete registry[ccId];
    writeRegistry(registry);
  });
}

/**
 * 检查 ccId 是否已注册
 */
export function isCcIdRegistered(ccId: string): boolean {
  const registry = readRegistry();
  return ccId in registry;
}

/**
 * 更新 ccId 的最后活跃时间
 */
export function touchCcId(ccId: string): void {
  withLock(() => {
    const registry = readRegistry();
    if (registry[ccId]) {
      registry[ccId].lastActive = Date.now();
      writeRegistry(registry);
    }
  });
}

/**
 * 获取 ccId 绑定的机器人名称
 */
export function getCcIdBinding(ccId: string): { robotName: string } | null {
  const registry = readRegistry();
  const entry = registry[ccId];
  if (!entry) return null;
  return { robotName: entry.robotName };
}

/**
 * 获取完整注册表（调试用）
 */
export function getRegistry(): Registry {
  return readRegistry();
}

// ────────────────────────────────────────────
// 心跳检测
// ────────────────────────────────────────────

let heartbeatInterval: NodeJS.Timeout | null = null;

/**
 * 检查 CC 心跳并发送离线通知
 */
async function checkCcHeartbeat(): Promise<void> {
  const registry = readRegistry();
  const now = Date.now();
  let changed = false;

  for (const [ccId, entry] of Object.entries(registry)) {
    const inactive = now - entry.lastActive;

    if (inactive > OFFLINE_THRESHOLD) {
      // 检查是否需要通知（避免重复）
      const shouldNotify = !entry.lastNotified ||
                           (now - entry.lastNotified > NOTIFICATION_INTERVAL);

      if (shouldNotify) {
        await sendOfflineNotification(ccId, entry.robotName);
        entry.lastNotified = now;
        changed = true;
      }
    }
  }

  if (changed) {
    withLock(() => {
      const reg = readRegistry();
      for (const [ccId, entry] of Object.entries(registry)) {
        if (entry.lastNotified && reg[ccId]) {
          reg[ccId].lastNotified = entry.lastNotified;
        }
      }
      writeRegistry(reg);
    });
  }
}

/**
 * 发送离线通知到微信
 */
async function sendOfflineNotification(ccId: string, robotName: string): Promise<void> {
  try {
    // 动态导入避免循环依赖
    const { getClient } = await import('./connection-manager.js');
    const client = await getClient(robotName);

    if (!client) {
      console.log(`[heartbeat] 机器人 ${robotName} 未连接，无法发送离线通知`);
      return;
    }

    const registryEntry = getRegistry()[ccId];
    const inactiveMinutes = registryEntry ? Math.floor((Date.now() - registryEntry.lastActive) / 60000) : 0;

    const message = `【系统警告】CC "${ccId}" 已超过 ${inactiveMinutes} 分钟无心跳，可能已离线。

可能原因：
• CC 进程已退出
• 网络连接中断
• CC 正在执行长时间任务

建议：请检查终端状态或重新启动 CC。`;

    await client.sendText(message);
    console.log(`[heartbeat] 已发送离线通知: ccId=${ccId}, robot=${robotName}`);
  } catch (err) {
    console.error(`[heartbeat] 发送离线通知失败:`, err);
  }
}

/**
 * 启动心跳检测（5 分钟扫描一次）
 */
export function startHeartbeatMonitor(): void {
  if (heartbeatInterval) return;

  heartbeatInterval = setInterval(() => {
    checkCcHeartbeat().catch(err => {
      console.error('[heartbeat] 心跳检测错误:', err);
    });
  }, 5 * 60 * 1000);

  console.log('[heartbeat] 心跳检测已启动（5 分钟周期）');
}

/**
 * 停止心跳检测
 */
export function stopHeartbeatMonitor(): void {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
    console.log('[heartbeat] 心跳检测已停止');
  }
}
