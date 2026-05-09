#!/usr/bin/env node
/**
 * wecom-aibot-mcp Stop hook (Node.js, 跨平台)
 *
 * Claude 准备停止时触发。如果当前项目处于微信模式，输出 exit code 2 阻止停止，
 * 同时通过 stderr 提示 Claude 调用 get_pending_messages 恢复轮询。
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const MCP_PORT = 18963;
const HOME = os.homedir();
const DEBUG_FILE = path.join(HOME, '.wecom-aibot-mcp', 'debug');
const CLAUDE_JSON = path.join(HOME, '.claude.json');

function log(msg: string): void {
  if (fs.existsSync(DEBUG_FILE)) {
    process.stderr.write(`[${new Date().toISOString()}] [stop] ${msg}\n`);
  }
}

function readStdinSync(): string {
  const chunks: Buffer[] = [];
  try {
    const buf = Buffer.alloc(65536);
    while (true) {
      const n = fs.readSync(0, buf, 0, buf.length, null);
      if (!n) break;
      chunks.push(Buffer.from(buf.subarray(0, n)));
    }
  } catch { /* ignore */ }
  return Buffer.concat(chunks).toString('utf-8');
}

async function fetchHealth(url: string, headers?: Record<string, string>, timeoutMs = 2000): Promise<boolean> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${url}/health`, { signal: ctrl.signal, headers });
    if (!res.ok) return false;
    const data = await res.json().catch(() => null) as any;
    return data?.status === 'ok';
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

async function main(): Promise<void> {
  // 消费 stdin（Claude 会传 stop 事件 JSON，我们不需要内容）
  readStdinSync();

  const projectDir = process.cwd();
  const configFile = path.join(projectDir, '.claude', 'wecom-aibot.json');
  if (!fs.existsSync(configFile)) {
    log('no config, allow stop');
    process.exit(0);
  }

  let cfg: any;
  try {
    cfg = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
  } catch {
    process.exit(0);
  }
  if (cfg?.wechatMode !== true) {
    log('wechatMode not true, allow stop');
    process.exit(0);
  }

  const ccId: string = cfg?.ccId || '';
  if (!ccId) {
    log('no ccId, allow stop');
    process.exit(0);
  }

  // 探测 daemon 是否在线，离线就允许停止
  let alive = await fetchHealth(`http://127.0.0.1:${MCP_PORT}`);
  if (!alive && fs.existsSync(CLAUDE_JSON)) {
    try {
      const claudeConfig = JSON.parse(fs.readFileSync(CLAUDE_JSON, 'utf-8'));
      const channel = claudeConfig?.mcpServers?.['wecom-aibot-channel'];
      const remoteUrl: string | undefined = channel?.env?.MCP_URL;
      const token: string | undefined = channel?.env?.MCP_AUTH_TOKEN;
      if (remoteUrl) {
        const headers: Record<string, string> = {};
        if (token) headers['Authorization'] = `Bearer ${token}`;
        alive = await fetchHealth(remoteUrl.replace(/\/+$/, ''), headers, 5000);
      }
    } catch { /* ignore */ }
  }

  if (!alive) {
    log('MCP server offline, allow stop');
    process.exit(0);
  }

  log(`WeChat mode active, blocking stop for ccId=${ccId}`);
  process.stderr.write(
    `任务已完成，请调用 mcp__wecom-aibot__get_pending_messages(cc_id="${ccId}", timeout_ms=30000) 恢复微信消息轮询\n`,
  );
  process.exit(2);
}

main().catch(() => process.exit(0));
