#!/usr/bin/env node
/**
 * wecom-aibot-mcp PermissionRequest hook (Node.js, 跨平台)
 *
 * 由 Claude Code 在工具调用前 stdin 喂入 JSON：
 *   { tool_name, tool_input, ... }
 * 我们 stdout 输出：
 *   { hookSpecificOutput: { hookEventName, decision: { behavior, message? } } }
 *
 * 决策逻辑：
 *   1. MCP 工具 / 只读工具 → 直接 allow
 *   2. 沿进程树向上查 active-projects.json，未匹配 → exit 0（不拦截）
 *   3. 项目无 .claude/wecom-aibot.json 或 wechatMode!=true → exit 0
 *   4. 探测本地 daemon /health；channel 模式或本地不通则尝试远程
 *   5. POST /approve 拿 taskId，轮询 /approval_status/:taskId
 *   6. 超时（autoApproveTimeout）→ 智能策略：
 *      - rm 命令 → 拒
 *      - 项目内 → 允许，项目外 → 拒
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';

const MCP_PORT = 18963;
const HOME = os.homedir();
const ACTIVE_INDEX = path.join(HOME, '.wecom-aibot-mcp', 'active-projects.json');
const DEBUG_FILE = path.join(HOME, '.wecom-aibot-mcp', 'debug');
const CLAUDE_JSON = path.join(HOME, '.claude.json');

const IS_WIN = process.platform === 'win32';

function log(msg: string): void {
  if (fs.existsSync(DEBUG_FILE)) {
    process.stderr.write(`[${new Date().toISOString()}] ${msg}\n`);
  }
}

function emit(decision: { behavior: 'allow' | 'deny'; message?: string }): void {
  const out = {
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision,
    },
  };
  process.stdout.write(JSON.stringify(out) + '\n');
}

function readStdinSync(): string {
  // hook 进程很短命，同步读 stdin 完整内容
  const chunks: Buffer[] = [];
  try {
    const buf = Buffer.alloc(65536);
    while (true) {
      const n = fs.readSync(0, buf, 0, buf.length, null);
      if (!n) break;
      chunks.push(Buffer.from(buf.subarray(0, n)));
    }
  } catch {
    // EAGAIN / closed
  }
  return Buffer.concat(chunks).toString('utf-8');
}

function getParentPid(pid: number): number {
  if (!pid || pid <= 1) return 0;
  try {
    if (IS_WIN) {
      const out = execSync(`wmic process where ProcessId=${pid} get ParentProcessId /value`, {
        stdio: ['ignore', 'pipe', 'ignore'],
      }).toString();
      const m = out.match(/ParentProcessId=(\d+)/);
      return m ? parseInt(m[1], 10) : 0;
    }
    return parseInt(execSync(`ps -o ppid= -p ${pid}`, {
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim(), 10) || 0;
  } catch {
    return 0;
  }
}

function findProjectFromActiveIndex(startPid: number): string | null {
  if (!fs.existsSync(ACTIVE_INDEX)) {
    log('No active-projects index');
    return null;
  }
  let entries: any[] = [];
  try {
    entries = JSON.parse(fs.readFileSync(ACTIVE_INDEX, 'utf-8'));
    if (!Array.isArray(entries)) return null;
  } catch {
    return null;
  }
  let pid = startPid;
  for (let i = 0; i < 8; i++) {
    if (!pid || pid <= 1) break;
    const hit = entries.find((e: any) => e?.pid === pid);
    if (hit?.projectDir) {
      log(`Matched PID ${pid} -> ${hit.projectDir}`);
      return hit.projectDir as string;
    }
    const parent = getParentPid(pid);
    if (!parent || parent === pid) break;
    pid = parent;
  }
  return null;
}

async function fetchJson(url: string, init?: RequestInit & { timeoutMs?: number }): Promise<any> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), init?.timeoutMs ?? 5000);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    if (!res.ok) return null;
    return await res.json().catch(() => null);
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

interface ServerEndpoint {
  baseUrl: string;
  authHeader?: string;
}

async function probeLocal(): Promise<ServerEndpoint | null> {
  const baseUrl = `http://127.0.0.1:${MCP_PORT}`;
  const data = await fetchJson(`${baseUrl}/health`, { timeoutMs: 2000 });
  return data?.status === 'ok' ? { baseUrl } : null;
}

async function probeRemote(): Promise<ServerEndpoint | null> {
  if (!fs.existsSync(CLAUDE_JSON)) return null;
  let claudeConfig: any;
  try {
    claudeConfig = JSON.parse(fs.readFileSync(CLAUDE_JSON, 'utf-8'));
  } catch {
    return null;
  }
  const channel = claudeConfig?.mcpServers?.['wecom-aibot-channel'];
  const remoteUrl: string | undefined = channel?.env?.MCP_URL;
  const remoteToken: string | undefined = channel?.env?.MCP_AUTH_TOKEN;
  if (!remoteUrl) return null;
  const baseUrl = remoteUrl.replace(/\/+$/, '');
  const headers: Record<string, string> = {};
  if (remoteToken) headers['Authorization'] = `Bearer ${remoteToken}`;
  const data = await fetchJson(`${baseUrl}/health`, { timeoutMs: 5000, headers });
  if (data?.status !== 'ok') return null;
  return remoteToken ? { baseUrl, authHeader: `Bearer ${remoteToken}` } : { baseUrl };
}

function authedHeaders(ep: ServerEndpoint, extra?: Record<string, string>): Record<string, string> {
  const h: Record<string, string> = { ...(extra || {}) };
  if (ep.authHeader) h['Authorization'] = ep.authHeader;
  return h;
}

function extractStringField(obj: any, ...keys: string[]): string {
  for (const k of keys) {
    if (typeof obj?.[k] === 'string' && obj[k]) return obj[k];
  }
  return '';
}

function isInProject(toolName: string, toolInput: any, projectDir: string): boolean {
  if (toolName === 'Bash') {
    const cmd: string = toolInput?.command || '';
    if (cmd.includes(projectDir)) return true;
    const absPaths = cmd.match(/(^|[ \t])(\/[A-Za-z0-9][^ \t>|;&]*|[A-Za-z]:\\[^ \t>|;&]+)/g) || [];
    const safe = (p: string) =>
      p.startsWith(projectDir) ||
      /^(\/tmp\/|\/var\/tmp\/|\/dev\/null|\/dev\/std|\/dev\/fd\/)/.test(p) ||
      /^[A-Za-z]:\\(Users\\[^\\]+\\AppData\\Local\\Temp\\|Windows\\Temp\\)/i.test(p);
    const outside = absPaths.map(s => s.trim()).filter(p => !safe(p));
    if (absPaths.length > 0 && outside.length > 0) return false;
    // 无可疑外部路径 → 以 cwd 为准
    return process.cwd().startsWith(projectDir);
  }
  if (toolName === 'Write' || toolName === 'Edit') {
    const fp = extractStringField(toolInput, 'file_path');
    return !fp || fp.startsWith(projectDir) || !path.isAbsolute(fp);
  }
  const fp = extractStringField(toolInput, 'file_path', 'path', 'directory');
  if (!fp) return true; // 无路径信息时倾向放行
  return fp.startsWith(projectDir) || !path.isAbsolute(fp);
}

function isDeleteCommand(toolName: string, toolInput: any): boolean {
  if (toolName !== 'Bash') return false;
  const cmd: string = (toolInput?.command || '').toString();
  const firstLine = cmd.split('\n')[0] || '';
  return /(^|[;&|(]\s*)(rm\s|rmdir\s|del\s|Remove-Item\s)/i.test(firstLine);
}

async function notifyTimeout(ep: ServerEndpoint, taskId: string, result: 'allow-once' | 'deny', reason: string): Promise<void> {
  await fetchJson(`${ep.baseUrl}/approval_timeout/${taskId}`, {
    method: 'POST',
    timeoutMs: 5000,
    headers: authedHeaders(ep, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ result, reason }),
  });
}

async function main(): Promise<void> {
  const raw = readStdinSync();
  let input: any = {};
  try {
    input = raw ? JSON.parse(raw) : {};
  } catch {
    log('stdin not JSON, exit 0');
    process.exit(0);
  }

  const toolName: string = input?.tool_name || '';
  log(`tool_name=${toolName}`);

  // MCP 工具：放行
  if (toolName.startsWith('mcp__')) {
    emit({ behavior: 'allow' });
    return;
  }

  // 只读工具：放行
  const readOnly = new Set([
    'Read', 'Glob', 'Grep', 'LS', 'TaskList', 'TaskGet', 'TaskOutput', 'TaskStop',
    'CronList', 'CronCreate', 'CronDelete', 'AskUserQuestion', 'Skill',
    'ListMcpResourcesTool', 'EnterPlanMode', 'ExitPlanMode',
    'WebSearch', 'WebFetch', 'NotebookEdit',
  ]);
  if (readOnly.has(toolName)) {
    emit({ behavior: 'allow' });
    return;
  }

  // 沿进程树查 active-projects.json
  const projectDir = findProjectFromActiveIndex(process.ppid || process.pid);
  if (!projectDir) {
    log('No active project match');
    process.exit(0);
  }

  const configFile = path.join(projectDir, '.claude', 'wecom-aibot.json');
  if (!fs.existsSync(configFile)) {
    log('No wecom-aibot.json in project');
    process.exit(0);
  }
  let cfg: any;
  try {
    cfg = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
  } catch {
    process.exit(0);
  }
  if (cfg?.wechatMode !== true) {
    log('wechatMode not true');
    process.exit(0);
  }

  const mode: 'http' | 'channel' = cfg?.mode === 'channel' ? 'channel' : 'http';
  const endpoint = mode === 'channel'
    ? (await probeRemote())
    : ((await probeLocal()) || (await probeRemote()));
  if (!endpoint) {
    log('No reachable MCP server');
    process.exit(0);
  }

  // 提交审批
  const body = {
    tool_name: toolName,
    tool_input: input?.tool_input ?? {},
    projectDir,
    robotName: cfg?.robotName || '',
    ccId: cfg?.ccId || '',
  };
  const approveRes = await fetchJson(`${endpoint.baseUrl}/approve`, {
    method: 'POST',
    timeoutMs: 10000,
    headers: authedHeaders(endpoint, { 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  });
  const taskId: string = approveRes?.taskId || '';
  if (!taskId) {
    log('No taskId returned');
    process.exit(0);
  }

  // 轮询
  const timeoutSec: number = Number(cfg?.autoApproveTimeout) || 300;
  const maxPoll = Math.max(1, Math.ceil(timeoutSec / 2));
  log(`Polling taskId=${taskId} maxPoll=${maxPoll}`);
  for (let i = 0; i < maxPoll; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const data = await fetchJson(`${endpoint.baseUrl}/approval_status/${taskId}`, {
      timeoutMs: 3000,
      headers: authedHeaders(endpoint),
    });
    const result = data?.result;
    if (result === 'allow-once' || result === 'allow-always') {
      emit({ behavior: 'allow' });
      return;
    }
    if (result === 'deny') {
      emit({ behavior: 'deny', message: '用户拒绝' });
      return;
    }
  }

  // 超时智能决策
  const toolInput = input?.tool_input ?? {};
  if (isDeleteCommand(toolName, toolInput)) {
    await notifyTimeout(endpoint, taskId, 'deny', '超时自动拒绝：删除操作需人工确认');
    emit({ behavior: 'deny', message: '超时自动拒绝：删除操作需人工确认' });
    return;
  }
  if (isInProject(toolName, toolInput, projectDir)) {
    await notifyTimeout(endpoint, taskId, 'allow-once', '超时自动允许：项目内操作');
    emit({ behavior: 'allow', message: '超时自动允许：项目内操作' });
    return;
  }
  await notifyTimeout(endpoint, taskId, 'deny', '超时自动拒绝：项目外操作需人工确认');
  emit({ behavior: 'deny', message: '超时自动拒绝：项目外操作需人工确认' });
}

main().catch(err => {
  log(`hook error: ${err?.message || err}`);
  // 任何错误都让 Claude 继续（exit 0 表示不干预）
  process.exit(0);
});
