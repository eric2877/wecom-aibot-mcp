/**
 * 统一日志模块
 *
 * 级别：error / info / debug
 * - error：永远写文件 + stderr
 * - info：永远写文件，--debug 时也写 stdout
 * - debug：仅 --debug 模式写文件 + stdout
 *
 * Debug 标记：~/.wecom-aibot-mcp/debug 文件存在 → debug 模式
 *
 * 文件输出：JSON Lines 格式，自动按 10MB 滚动，保留最近 5 份
 *   <file>      当前
 *   <file>.1    上一份
 *   ...
 *   <file>.5    最旧
 *
 * 调用方在入口处通过 setLogFile() 指定写入文件：
 * - daemon (`--start` / `--debug`): server.log
 * - channel-server (`--channel`):    channel.log
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const CONFIG_DIR = path.join(os.homedir(), '.wecom-aibot-mcp');
const DEBUG_FILE = path.join(CONFIG_DIR, 'debug');
const MAX_SIZE = 10 * 1024 * 1024; // 10 MB
const KEEP_FILES = 5;

let logFile: string | null = null;
let debugMode = false;

export function isDebugMode(): boolean {
  if (debugMode) return true;
  if (fs.existsSync(DEBUG_FILE)) {
    debugMode = true;
    return true;
  }
  return false;
}

export function setDebugMode(enabled: boolean): void {
  debugMode = enabled;
  if (enabled && !fs.existsSync(DEBUG_FILE)) {
    if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(DEBUG_FILE, 'true');
  } else if (!enabled && fs.existsSync(DEBUG_FILE)) {
    fs.unlinkSync(DEBUG_FILE);
  }
}

export function setLogFile(file: string): void {
  logFile = file;
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function rotate(file: string): void {
  try {
    for (let i = KEEP_FILES - 1; i >= 1; i--) {
      const src = `${file}.${i}`;
      const dst = `${file}.${i + 1}`;
      if (fs.existsSync(src)) fs.renameSync(src, dst);
    }
    if (fs.existsSync(file)) fs.renameSync(file, `${file}.1`);
  } catch {
    // 滚动失败忽略，避免阻塞日志写入
  }
}

function write(level: 'error' | 'info' | 'debug', msg: string, data?: unknown): void {
  if (level === 'debug' && !isDebugMode()) return;

  const entry =
    JSON.stringify({
      ts: new Date().toISOString(),
      level,
      msg,
      ...(data !== undefined ? { data } : {}),
    }) + '\n';

  // 文件
  if (logFile) {
    try {
      if (fs.existsSync(logFile) && fs.statSync(logFile).size >= MAX_SIZE) {
        rotate(logFile);
      }
      fs.appendFileSync(logFile, entry);
    } catch {
      // 写文件失败不抛
    }
  }

  // 控制台
  if (level === 'error') {
    process.stderr.write(entry);
  } else if (debugMode) {
    process.stdout.write(entry);
  }
}

// 公共 API
export const logger = {
  info: (msg: string, data?: unknown) => write('info', msg, data),
  debug: (msg: string, data?: unknown) => write('debug', msg, data),
  error: (msg: string, data?: unknown) => write('error', msg, data),

  // 兼容旧 API（散落在各处的调用）
  log: (...args: unknown[]) => {
    if (debugMode) console.log(...args);
  },
  warn: (...args: unknown[]) => console.warn(...args),

  isDebug: isDebugMode,
  setDebug: setDebugMode,
  setLogFile,
};
