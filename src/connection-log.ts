/**
 * 连接状态日志模块
 *
 * 记录 WebSocket 连接状态变化，便于分析连接问题
 */

import * as fs from 'fs';
import * as path from 'path';

const CONFIG_DIR = path.join(process.env.HOME || '', '.wecom-aibot-mcp');
const LOG_FILE = path.join(CONFIG_DIR, 'connection.log');

// 连接状态记录
interface ConnectionRecord {
  event: 'connected' | 'authenticated' | 'disconnected' | 'reconnecting' | 'error' | 'warn';
  timestamp: string;
  isoTime: string;
  reason?: string;
  attempt?: number;
  errorMessage?: string;
  connectionDuration?: number;  // 本次连接持续时长（秒）
}

// 连接统计
interface ConnectionStats {
  totalConnections: number;      // 总连接次数
  totalDisconnections: number;   // 总断开次数
  totalReconnects: number;       // 总重连次数
  totalErrors: number;           // 总错误次数
  lastConnectTime?: string;      // 最后连接时间
  lastDisconnectTime?: string;   // 最后断开时间
  longestConnection?: number;    // 最长连接时长（秒）
  totalConnectionTime?: number;  // 累计连接时长（秒）
}

// 全局状态
let currentConnectionStart: number | null = null;
let stats: ConnectionStats = {
  totalConnections: 0,
  totalDisconnections: 0,
  totalReconnects: 0,
  totalErrors: 0,
};

// 确保配置目录存在
function ensureConfigDir(): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

// 写入日志
function writeLog(record: ConnectionRecord): void {
  ensureConfigDir();

  const logLine = JSON.stringify(record) + '\n';
  fs.appendFileSync(LOG_FILE, logLine, 'utf-8');

  // 同时输出到控制台
  const time = record.timestamp;
  switch (record.event) {
    case 'connected':
      console.log(`[${time}] [conn] WebSocket 连接已建立`);
      break;
    case 'authenticated':
      console.log(`[${time}] [conn] 认证成功`);
      break;
    case 'disconnected':
      const duration = record.connectionDuration ? ` (持续 ${record.connectionDuration}s)` : '';
      console.log(`[${time}] [conn] 连接断开: ${record.reason || '未知'}${duration}`);
      break;
    case 'reconnecting':
      console.log(`[${time}] [conn] 正在重连 (第 ${record.attempt} 次)`);
      break;
    case 'error':
      console.error(`[${time}] [conn] 错误: ${record.errorMessage}`);
      break;
  }
}

// 更新统计
function updateStats(record: ConnectionRecord): void {
  switch (record.event) {
    case 'connected':
      stats.totalConnections++;
      stats.lastConnectTime = record.isoTime;
      currentConnectionStart = Date.now();
      break;
    case 'disconnected':
      stats.totalDisconnections++;
      stats.lastDisconnectTime = record.isoTime;
      if (currentConnectionStart && record.connectionDuration) {
        stats.totalConnectionTime = (stats.totalConnectionTime || 0) + record.connectionDuration;
        if (!stats.longestConnection || record.connectionDuration > stats.longestConnection) {
          stats.longestConnection = record.connectionDuration;
        }
      }
      currentConnectionStart = null;
      break;
    case 'reconnecting':
      stats.totalReconnects++;
      break;
    case 'error':
      stats.totalErrors++;
      break;
  }

  // 持久化统计
  saveStats();
}

// 保存统计到文件
function saveStats(): void {
  ensureConfigDir();
  const statsFile = path.join(CONFIG_DIR, 'connection-stats.json');
  fs.writeFileSync(statsFile, JSON.stringify(stats, null, 2), 'utf-8');
}

// 加载统计
export function loadStats(): ConnectionStats {
  const statsFile = path.join(CONFIG_DIR, 'connection-stats.json');
  if (fs.existsSync(statsFile)) {
    try {
      const content = fs.readFileSync(statsFile, 'utf-8');
      stats = { ...stats, ...JSON.parse(content) };
    } catch (e) {
      // ignore
    }
  }
  return stats;
}

// 记录连接建立
export function logConnected(): void {
  const now = new Date();
  const record: ConnectionRecord = {
    event: 'connected',
    timestamp: now.toISOString().replace('T', ' ').slice(0, 19),
    isoTime: now.toISOString(),
  };
  writeLog(record);
  updateStats(record);
}

// 记录认证成功
export function logAuthenticated(): void {
  const now = new Date();
  const record: ConnectionRecord = {
    event: 'authenticated',
    timestamp: now.toISOString().replace('T', ' ').slice(0, 19),
    isoTime: now.toISOString(),
  };
  writeLog(record);
  // 认证成功也算作连接成功
  updateStats({ ...record, event: 'connected' });
}

// 记录连接断开
export function logDisconnected(reason: string): void {
  const now = new Date();
  let connectionDuration: number | undefined;

  if (currentConnectionStart) {
    connectionDuration = Math.floor((Date.now() - currentConnectionStart) / 1000);
  }

  const record: ConnectionRecord = {
    event: 'disconnected',
    timestamp: now.toISOString().replace('T', ' ').slice(0, 19),
    isoTime: now.toISOString(),
    reason,
    connectionDuration,
  };
  writeLog(record);
  updateStats(record);
}

// 记录重连尝试
export function logReconnecting(attempt: number): void {
  const now = new Date();
  const record: ConnectionRecord = {
    event: 'reconnecting',
    timestamp: now.toISOString().replace('T', ' ').slice(0, 19),
    isoTime: now.toISOString(),
    attempt,
  };
  writeLog(record);
  updateStats(record);
}

// 记录错误
export function logError(errorMessage: string): void {
  const now = new Date();
  const record: ConnectionRecord = {
    event: 'error',
    timestamp: now.toISOString().replace('T', ' ').slice(0, 19),
    isoTime: now.toISOString(),
    errorMessage,
  };
  writeLog(record);
  updateStats(record);
}

export function logWarn(message: string): void {
  const now = new Date();
  const record: ConnectionRecord = {
    event: 'warn',
    timestamp: now.toISOString().replace('T', ' ').slice(0, 19),
    isoTime: now.toISOString(),
    errorMessage: message,
  };
  writeLog(record);
}

// 获取当前统计
export function getStats(): ConnectionStats {
  return { ...stats };
}

// 获取最近的日志记录
export function getRecentLogs(count: number = 50): ConnectionRecord[] {
  if (!fs.existsSync(LOG_FILE)) {
    return [];
  }

  const content = fs.readFileSync(LOG_FILE, 'utf-8');
  const lines = content.trim().split('\n').filter(Boolean);

  return lines.slice(-count).map(line => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }).filter((r): r is ConnectionRecord => r !== null);
}

// 清理旧日志（保留最近 N 天）
export function cleanupOldLogs(daysToKeep: number = 30): void {
  if (!fs.existsSync(LOG_FILE)) {
    return;
  }

  const cutoff = Date.now() - daysToKeep * 24 * 60 * 60 * 1000;
  const content = fs.readFileSync(LOG_FILE, 'utf-8');
  const lines = content.trim().split('\n').filter(Boolean);

  const recentLines = lines.filter(line => {
    try {
      const record = JSON.parse(line);
      const recordTime = new Date(record.isoTime).getTime();
      return recordTime >= cutoff;
    } catch {
      return true; // 解析失败的保留
    }
  });

  fs.writeFileSync(LOG_FILE, recentLines.join('\n') + '\n', 'utf-8');
  console.log(`[conn] 已清理 ${lines.length - recentLines.length} 条旧日志`);
}

// 导出日志文件路径
export function getLogFilePath(): string {
  return LOG_FILE;
}

export function getStatsFilePath(): string {
  return path.join(CONFIG_DIR, 'connection-stats.json');
}