/**
 * 统一日志模块
 *
 * 通过 --debug 参数控制日志输出：
 * - debug 模式：所有日志输出到 stderr
 * - 正常模式：只输出必要信息（如错误、启动消息）
 *
 * Debug 标记文件：~/.wecom-aibot-mcp/debug
 *
 * 用法与 console 完全一致：
 * - logger.log() - debug 模式才输出
 * - logger.error() - 始终输出到 stderr
 * - logger.warn() - 始终输出到 stderr
 * - logger.info() - 始终输出到 stdout
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const DEBUG_FILE = path.join(os.homedir(), '.wecom-aibot-mcp', 'debug');

let debugMode = false;

/**
 * 检查是否处于 debug 模式
 */
export function isDebugMode(): boolean {
  if (debugMode) return true;

  // 检查标记文件
  if (fs.existsSync(DEBUG_FILE)) {
    debugMode = true;
    return true;
  }
  return false;
}

/**
 * 设置 debug 模式
 */
export function setDebugMode(enabled: boolean): void {
  debugMode = enabled;

  if (enabled && !fs.existsSync(DEBUG_FILE)) {
    fs.writeFileSync(DEBUG_FILE, 'true');
  } else if (!enabled && fs.existsSync(DEBUG_FILE)) {
    fs.unlinkSync(DEBUG_FILE);
  }
}

/**
 * 日志输出（仅 debug 模式）
 * 与 console.log 用法完全一致
 */
export function log(...args: unknown[]): void {
  if (isDebugMode()) {
    console.log(...args);
  }
}

/**
 * 错误日志（始终输出到 stderr）
 * 与 console.error 用法完全一致
 */
export function error(...args: unknown[]): void {
  console.error(...args);
}

/**
 * 信息日志（始终输出到 stdout）
 * 与 console.info 用法完全一致
 */
export function info(...args: unknown[]): void {
  console.info(...args);
}

/**
 * 警告日志（始终输出到 stderr）
 * 与 console.warn 用法完全一致
 */
export function warn(...args: unknown[]): void {
  console.warn(...args);
}

// 导出 logger 对象，用法与 console 完全一致
export const logger = {
  log,
  error,
  info,
  warn,
  isDebug: isDebugMode,
  setDebug: setDebugMode,
};