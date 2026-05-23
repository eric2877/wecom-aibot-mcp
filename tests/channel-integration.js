#!/usr/bin/env node
/**
 * Channel Server 集成测试
 *
 * 测试 channel-server (--channel 模式) 的工具转发和接口功能：
 * 1. 启动 Docker server daemon
 * 2. 通过 MCP stdio 协议与 channel-server 交互
 * 3. 验证工具列表与 HTTP MCP 一致
 * 4. 验证工具调用转发（enter_headless_mode、list_active_ccs、send_to_cc）
 * 5. 验证 SSE 订阅通道（get_pending_messages）
 *
 * 用法:
 *   node tests/channel-integration.js
 * 前提:
 *   已有 .env.test 文件，Docker 已安装，项目已 build
 */

import { spawn, execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.join(__dirname, '..');

// ─── 颜色输出 ─────────────────────────────────────────
const GREEN = '\x1b[0;32m';
const RED = '\x1b[0;31m';
const YELLOW = '\x1b[1;33m';
const NC = '\x1b[0m';

let PASS = 0;
let FAIL = 0;
function pass(label) { console.log(`${GREEN}✅ PASS${NC} ${label}`); PASS++; }
function fail(label, detail = '') { console.log(`${RED}❌ FAIL${NC} ${label}${detail ? ': ' + detail : ''}`); FAIL++; }
function info(msg) { console.log(`${YELLOW}ℹ️  ${msg}${NC}`); }

// 测试 bot 凭证（专用测试机器人，与生产 bot 独立）
const AUTH_TOKEN = 'test-token-docker';
const BASE_URL = 'http://localhost:18963';
const CHANNEL_BIN = path.join(ROOT, 'dist', 'bin.js');

// ─── MCP stdio 客户端 ─────────────────────────────────
// MCP SDK stdio 使用换行分隔 JSON（NDJSON），每条消息是一行 JSON + \n
class McpStdioClient {
  constructor(proc) {
    this.proc = proc;
    this.lineBuf = '';
    this.pending = new Map();
    this.nextId = 1;
    this.notifications = [];

    proc.stdout.on('data', (chunk) => {
      this.lineBuf += chunk.toString();
      this._drain();
    });
    proc.stderr.on('data', (d) => {
      // channel-server writes logs to stderr — suppress unless debugging
    });
  }

  _drain() {
    let nl;
    while ((nl = this.lineBuf.indexOf('\n')) !== -1) {
      const line = this.lineBuf.slice(0, nl).trim();
      this.lineBuf = this.lineBuf.slice(nl + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id != null && this.pending.has(msg.id)) {
          const { resolve } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          resolve(msg);
        } else if (msg.method) {
          this.notifications.push(msg);
        }
      } catch { /* ignore parse errors */ }
    }
  }

  send(msg) {
    this.proc.stdin.write(JSON.stringify(msg) + '\n');
  }

  call(method, params, timeoutMs = 10000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (msg) => { clearTimeout(timer); resolve(msg); },
      });
      this.send({ jsonrpc: '2.0', method, params, id });
    });
  }

  close() {
    try { this.proc.stdin.end(); } catch {}
  }
}

// ─── Docker 管理 ──────────────────────────────────────
function dockerUp() {
  info('Building and starting Docker server...');
  execSync(
    `docker compose -f docker-compose.test.yml up -d --build`,
    { cwd: ROOT, stdio: 'pipe' }
  );
}

function dockerDown() {
  info('Stopping Docker containers...');
  execSync(
    `docker compose -f docker-compose.test.yml down`,
    { cwd: ROOT, stdio: 'pipe' }
  );
}

async function waitHealthy(retries = 30, delayMs = 1000) {
  info('Waiting for server to be healthy...');
  for (let i = 1; i <= retries; i++) {
    try {
      const res = await fetch(`${BASE_URL}/health`);
      const json = await res.json();
      if (json.status === 'ok') { info(`Server is up (attempt ${i})`); return; }
    } catch {}
    await new Promise(r => setTimeout(r, delayMs));
  }
  throw new Error('Server did not become healthy');
}

async function waitRobotConnected(retries = 15, delayMs = 1000) {
  info('Waiting for robot WebSocket connection...');
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(`${BASE_URL}/state`, {
        headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
      });
      const json = await res.json();
      if (json.connected) { info('Robot connected'); return; }
    } catch {}
    await new Promise(r => setTimeout(r, delayMs));
  }
  info('Robot may not be connected (continuing anyway)');
}

// ─── 主测试流程 ──────────────────────────────────────
async function main() {
  console.log('');
  console.log('══════════════════════════════════════════════');
  console.log('  wecom-aibot-mcp Channel Server 集成测试');
  console.log('══════════════════════════════════════════════');
  console.log('');

  // 检查 build 产物
  if (!fs.existsSync(CHANNEL_BIN)) {
    console.error(`ERROR: ${CHANNEL_BIN} not found. Run npm run build first.`);
    process.exit(1);
  }

  dockerUp();
  await waitHealthy();
  await waitRobotConnected();

  // 启动 channel-server 进程
  info('Spawning channel-server (--channel mode)...');
  const channelProc = spawn('node', [CHANNEL_BIN, '--channel'], {
    env: {
      ...process.env,
      MCP_URL: BASE_URL,
      MCP_AUTH_TOKEN: AUTH_TOKEN,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const client = new McpStdioClient(channelProc);
  let ccId = null;

  try {
    // ── 1. MCP 初始化 ───────────────────────────────
    console.log('\n── 1. MCP 初始化 ──────────────────────────────');
    const initResp = await client.call('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'channel-test', version: '1.0' },
    });
    if (initResp.result?.serverInfo?.name) {
      pass(`initialize 成功，server: ${initResp.result.serverInfo.name}`);
    } else {
      fail('initialize 响应缺少 serverInfo', JSON.stringify(initResp));
    }

    // 发送 initialized 通知（协议要求）
    client.send({ jsonrpc: '2.0', method: 'notifications/initialized' });

    // ── 2. 工具列表转发 ────────────────────────────
    console.log('\n── 2. 工具列表转发 ────────────────────────────');
    const toolsResp = await client.call('tools/list', {});
    const tools = toolsResp.result?.tools ?? [];
    if (tools.length > 0) {
      pass(`tools/list 返回 ${tools.length} 个工具`);
    } else {
      fail('tools/list 返回空列表', JSON.stringify(toolsResp));
    }

    // 对比 HTTP MCP 的工具数
    async function httpMcpCall(sessionId, method, params, callId) {
      const res = await fetch(`${BASE_URL}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream',
          Authorization: `Bearer ${AUTH_TOKEN}`,
          ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
        },
        body: JSON.stringify({ jsonrpc: '2.0', method, params, id: callId }),
      });
      const text = await res.text();
      // SSE or plain JSON
      const dataLine = text.split('\n').find(l => l.startsWith('data: '));
      const json = dataLine ? JSON.parse(dataLine.slice(6)) : JSON.parse(text);
      return { json, sessionId: res.headers.get('mcp-session-id') || sessionId };
    }
    const initHttp = await httpMcpCall(null, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } }, 1);
    const toolsHttp = await httpMcpCall(initHttp.sessionId, 'tools/list', {}, 2);
    const httpToolCount = toolsHttp.json.result?.tools?.length ?? 0;

    if (tools.length >= httpToolCount) {
      pass(`Channel 工具数 (${tools.length}) ≥ HTTP MCP 工具数 (${httpToolCount})`);
    } else {
      fail(`Channel 工具数 (${tools.length}) < HTTP MCP 工具数 (${httpToolCount})`);
    }

    // 检查关键工具存在
    const toolNames = tools.map(t => t.name);
    const requiredTools = ['enter_headless_mode', 'send_message', 'get_pending_messages', 'list_active_ccs'];
    for (const t of requiredTools) {
      if (toolNames.includes(t)) {
        pass(`工具存在: ${t}`);
      } else {
        fail(`工具缺失: ${t}`);
      }
    }

    // ── 3. enter_headless_mode（注册 ccId）────────
    console.log('\n── 3. enter_headless_mode（注册 ccId）──────────');
    const enterResp = await client.call('tools/call', {
      name: 'enter_headless_mode',
      arguments: {
        robot_name: 'docker-test-bot',
        project_dir: '/tmp/channel-test',
        agent_name: 'channel-test-agent',
      },
    }, 15000);
    const enterText = enterResp.result?.content?.[0]?.text ?? '';
    try {
      const enterJson = JSON.parse(enterText);
      ccId = enterJson.ccId;
      if (ccId) {
        pass(`enter_headless_mode 成功，ccId: ${ccId}`);
      } else {
        fail('enter_headless_mode 未返回 ccId', enterText);
      }
    } catch {
      fail('enter_headless_mode 响应非 JSON', enterText);
    }

    // ── 4. list_active_ccs（工具转发验证）────────
    console.log('\n── 4. list_active_ccs（工具转发验证）───────────');
    const listResp = await client.call('tools/call', {
      name: 'list_active_ccs',
      arguments: {},
    }, 10000);
    const listText = listResp.result?.content?.[0]?.text ?? '';
    if (listText && !listResp.error) {
      pass(`list_active_ccs 转发成功: ${listText.slice(0, 80)}`);
    } else {
      fail('list_active_ccs 转发失败', JSON.stringify(listResp));
    }

    // ── 5. check_connection（接口转发）────────────
    console.log('\n── 5. check_connection（接口转发）──────────────');
    const connResp = await client.call('tools/call', {
      name: 'check_connection',
      arguments: {},
    }, 10000);
    const connText = connResp.result?.content?.[0]?.text ?? '';
    if (connText && !connResp.error) {
      pass(`check_connection 转发成功: ${connText.slice(0, 80)}`);
    } else {
      fail('check_connection 转发失败', JSON.stringify(connResp));
    }

    // ── 6. send_to_cc（CC 间消息转发）─────────────
    console.log('\n── 6. send_to_cc（CC 间消息转发）───────────────');
    if (ccId) {
      const sendCcResp = await client.call('tools/call', {
        name: 'send_to_cc',
        arguments: {
          target_cc_id: ccId,
          message: '[channel-integration-test] send_to_cc 测试',
        },
      }, 10000);
      const sendCcText = sendCcResp.result?.content?.[0]?.text ?? '';
      if (sendCcText && !sendCcResp.error) {
        pass(`send_to_cc 转发成功: ${sendCcText.slice(0, 80)}`);
      } else {
        fail('send_to_cc 转发失败', JSON.stringify(sendCcResp));
      }
    } else {
      info('跳过 send_to_cc（无 ccId）');
    }

    // ── 7. get_pending_messages（SSE 轮询）────────
    console.log('\n── 7. get_pending_messages（SSE 轮询）──────────');
    if (ccId) {
      const pendingResp = await client.call('tools/call', {
        name: 'get_pending_messages',
        arguments: { cc_id: ccId, timeout_ms: 2000 },
      }, 10000);
      const pendingText = pendingResp.result?.content?.[0]?.text ?? '';
      if (!pendingResp.error) {
        pass(`get_pending_messages 完成: ${pendingText.slice(0, 80)}`);
      } else {
        fail('get_pending_messages 失败', JSON.stringify(pendingResp));
      }
    } else {
      info('跳过 get_pending_messages（无 ccId）');
    }

    // ── 8. exit_headless_mode（清理）──────────────
    console.log('\n── 8. exit_headless_mode（清理）────────────────');
    if (ccId) {
      const exitResp = await client.call('tools/call', {
        name: 'exit_headless_mode',
        arguments: { cc_id: ccId },
      }, 10000);
      const exitText = exitResp.result?.content?.[0]?.text ?? '';
      if (!exitResp.error) {
        pass(`exit_headless_mode 成功: ${exitText.slice(0, 60)}`);
      } else {
        fail('exit_headless_mode 失败', JSON.stringify(exitResp));
      }
    }

  } catch (err) {
    fail('测试异常', err.message);
  } finally {
    client.close();
    channelProc.kill('SIGTERM');
    // 强制清理：移除测试遗留的 active-projects.json 条目，避免污染生产环境
    try {
      const apFile = path.join(os.homedir(), '.wecom-aibot-mcp', 'active-projects.json');
      if (fs.existsSync(apFile)) {
        const entries = JSON.parse(fs.readFileSync(apFile, 'utf-8'));
        const cleaned = entries.filter(e => e.projectDir !== '/tmp/channel-test');
        fs.writeFileSync(apFile, JSON.stringify(cleaned, null, 2));
      }
    } catch { /* ignore */ }
    dockerDown();
  }

  console.log('');
  console.log('══════════════════════════════════════════════');
  const passStr = `${GREEN}PASS: ${PASS}${NC}`;
  const failStr = FAIL > 0 ? `${RED}FAIL: ${FAIL}${NC}` : `\x1b[0;32mFAIL: ${FAIL}${NC}`;
  console.log(`  测试结果：${passStr}  ${failStr}`);
  console.log('══════════════════════════════════════════════');

  process.exit(FAIL > 0 ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
