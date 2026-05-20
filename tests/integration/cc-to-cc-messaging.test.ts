/**
 * CC 间消息互通集成测试（v2.6.0）
 *
 * 验证：
 * - publishCcMessage → 只发往目标 ccId 的 SSE 连接
 * - 非目标 CC 不收到
 * - 消息 payload 字段正确
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const CONFIG_DIR = path.join(os.homedir(), '.wecom-aibot-mcp');
const ROBOT_CONFIG = path.join(CONFIG_DIR, 'robot-test-cc-msg.json');
const SERVER_CONFIG_FILE = path.join(CONFIG_DIR, 'server.json');
const TEST_PORT = 18968;

// 防御并行测试时另一测试文件临时写入 server.json 导致 401：
// 请求时读一次当前 token（如果有就带 Bearer header）
function readCurrentAuthToken(): string | undefined {
  try {
    if (!fs.existsSync(SERVER_CONFIG_FILE)) return undefined;
    return JSON.parse(fs.readFileSync(SERVER_CONFIG_FILE, 'utf-8')).authToken;
  } catch { return undefined; }
}

/** 打开一个 SSE 连接，返回事件流读取器 */
function openSseClient(port: number, ccId: string): Promise<{
  events: Array<{ event: string; data: string }>;
  close: () => void;
  ready: Promise<void>;
}> {
  return new Promise((resolveOpen, rejectOpen) => {
    const events: Array<{ event: string; data: string }> = [];
    let currentEvent = 'message';
    let buffer = '';
    let readyResolved = false;
    let readyResolve: () => void = () => {};
    const ready = new Promise<void>(r => { readyResolve = r; });

    const token = readCurrentAuthToken();
    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const req = http.get(
      { hostname: '127.0.0.1', port, path: `/sse/${ccId}?ccId=${ccId}`, headers },
      (res) => {
        if (res.statusCode !== 200) {
          rejectOpen(new Error(`SSE status ${res.statusCode}`));
          return;
        }
        res.setEncoding('utf-8');
        res.on('data', (chunk: string) => {
          buffer += chunk;
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (const line of lines) {
            if (line.startsWith('event: ')) currentEvent = line.slice(7).trim();
            else if (line.startsWith('data: ')) events.push({ event: currentEvent, data: line.slice(6) });
            else if (line === '') currentEvent = 'message';
            // first 'connected' event arrives quickly; signal ready then
            if (!readyResolved && events.find(e => e.event === 'connected')) {
              readyResolved = true;
              readyResolve();
            }
          }
        });
        res.on('error', () => { /* ignore */ });
        resolveOpen({ events, close: () => req.destroy(), ready });
      }
    );
    req.on('error', rejectOpen);
  });
}

function waitFor<T>(predicate: () => T | undefined, timeoutMs = 2000): Promise<T> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      const v = predicate();
      if (v !== undefined && v !== null && v !== false) return resolve(v as T);
      if (Date.now() > deadline) return reject(new Error('waitFor timeout'));
      setTimeout(tick, 25);
    };
    tick();
  });
}

describe('CC-to-CC 消息互通集成测试', () => {
  let serverModule: typeof import('../../src/http-server');
  let busModule: typeof import('../../src/message-bus');

  beforeAll(async () => {
    if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(ROBOT_CONFIG, JSON.stringify({
      botId: 'cc-test-bot', secret: 'secret', targetUserId: 'tester', nameTag: 'cc-test-robot',
    }));

    serverModule = await import('../../src/http-server.js');
    busModule = await import('../../src/message-bus.js');

    const mockMcpServer = {
      server: { notification: async () => {} },
      connect: async () => {},
    };
    await serverModule.startHttpServer(mockMcpServer as any, TEST_PORT);
  }, 30000);

  afterAll(() => {
    serverModule.stopHttpServer();
    if (fs.existsSync(ROBOT_CONFIG)) fs.unlinkSync(ROBOT_CONFIG);
  });

  it('publishCcMessage 应该只投递到目标 ccId 的 SSE 连接', async () => {
    serverModule.registerCcId('cc-alpha', 'cc-test-robot', 'agent-alpha', 'channel');
    serverModule.registerCcId('cc-beta', 'cc-test-robot', 'agent-beta', 'channel');

    const alpha = await openSseClient(TEST_PORT, 'cc-alpha');
    const beta = await openSseClient(TEST_PORT, 'cc-beta');
    await alpha.ready;
    await beta.ready;

    // alpha → beta
    busModule.publishCcMessage({
      msgId: 'm1', fromCc: 'cc-alpha', toCc: 'cc-beta',
      content: 'hello beta', kind: 'request', hopCount: 0, timestamp: Date.now(),
    });

    // beta 应该收到 cc_message
    const betaMsg = await waitFor(() => beta.events.find(e => e.event === 'cc_message'));
    const payload = JSON.parse(betaMsg.data);
    expect(payload.fromCc).toBe('cc-alpha');
    expect(payload.toCc).toBe('cc-beta');
    expect(payload.content).toBe('hello beta');
    expect(payload.kind).toBe('request');

    // alpha 应该 *没* 收到这条
    const alphaCc = alpha.events.find(e => e.event === 'cc_message');
    expect(alphaCc).toBeUndefined();

    alpha.close();
    beta.close();
    serverModule.unregisterCcId('cc-alpha');
    serverModule.unregisterCcId('cc-beta');
  });

  it('目标 CC 不在线时 publishCcMessage 不报错且不投递', async () => {
    serverModule.registerCcId('cc-gamma', 'cc-test-robot', 'agent-gamma', 'channel');
    const gamma = await openSseClient(TEST_PORT, 'cc-gamma');
    await gamma.ready;

    // 投递给一个未注册的 ccId
    expect(() => busModule.publishCcMessage({
      msgId: 'm2', fromCc: 'cc-gamma', toCc: 'cc-ghost',
      content: 'into the void', kind: 'notify', hopCount: 0, timestamp: Date.now(),
    })).not.toThrow();

    // gamma 不会收到（也没人收到）
    await new Promise(r => setTimeout(r, 200));
    const gammaCc = gamma.events.find(e => e.event === 'cc_message');
    expect(gammaCc).toBeUndefined();

    gamma.close();
    serverModule.unregisterCcId('cc-gamma');
  });

  it('多个 SSE 客户端同时订阅时，每个目标只收到属于自己的消息', async () => {
    serverModule.registerCcId('cc-x', 'cc-test-robot', 'agent-x', 'channel');
    serverModule.registerCcId('cc-y', 'cc-test-robot', 'agent-y', 'channel');
    serverModule.registerCcId('cc-z', 'cc-test-robot', 'agent-z', 'channel');

    const x = await openSseClient(TEST_PORT, 'cc-x');
    const y = await openSseClient(TEST_PORT, 'cc-y');
    const z = await openSseClient(TEST_PORT, 'cc-z');
    await Promise.all([x.ready, y.ready, z.ready]);

    busModule.publishCcMessage({
      msgId: 'mx-y', fromCc: 'cc-x', toCc: 'cc-y',
      content: 'to y', kind: 'notify', hopCount: 0, timestamp: Date.now(),
    });
    busModule.publishCcMessage({
      msgId: 'my-z', fromCc: 'cc-y', toCc: 'cc-z',
      content: 'to z', kind: 'notify', hopCount: 0, timestamp: Date.now(),
    });

    const yMsg = await waitFor(() => y.events.find(e => e.event === 'cc_message'));
    const zMsg = await waitFor(() => z.events.find(e => e.event === 'cc_message'));

    expect(JSON.parse(yMsg.data).toCc).toBe('cc-y');
    expect(JSON.parse(zMsg.data).toCc).toBe('cc-z');

    // x 不应收到任何 cc_message（它是发送方，不是接收方）
    expect(x.events.find(e => e.event === 'cc_message')).toBeUndefined();

    x.close(); y.close(); z.close();
    serverModule.unregisterCcId('cc-x');
    serverModule.unregisterCcId('cc-y');
    serverModule.unregisterCcId('cc-z');
  });

  // v2.6.1: 目标 CC 离线时入队，SSE 连上后立即 flush
  it('目标 CC 离线时入队，SSE 重新连上时立即收到积压消息', async () => {
    serverModule.registerCcId('cc-offline', 'cc-test-robot', 'agent-offline', 'channel');

    // 目标尚未打开 SSE → hasActiveSseFor 应为 false
    expect(serverModule.hasActiveSseFor('cc-offline')).toBe(false);

    // 入队 2 条消息
    serverModule.enqueueCcPending({
      msgId: 'queued-1', fromCc: 'cc-sender', toCc: 'cc-offline',
      content: 'msg1', kind: 'request', hopCount: 0, timestamp: Date.now(),
    });
    serverModule.enqueueCcPending({
      msgId: 'queued-2', fromCc: 'cc-sender', toCc: 'cc-offline',
      content: 'msg2', kind: 'notify', hopCount: 0, timestamp: Date.now(),
    });

    // SSE 连上来 → 应立即收到 2 条 cc_message
    const offline = await openSseClient(TEST_PORT, 'cc-offline');
    await offline.ready;

    await waitFor(() => offline.events.filter(e => e.event === 'cc_message').length >= 2);
    const ccMsgs = offline.events.filter(e => e.event === 'cc_message').map(e => JSON.parse(e.data));
    expect(ccMsgs.length).toBeGreaterThanOrEqual(2);
    expect(ccMsgs.map(m => m.msgId).sort()).toEqual(['queued-1', 'queued-2']);
    expect(ccMsgs.every(m => m.toCc === 'cc-offline')).toBe(true);

    // hasActiveSseFor 现在应为 true
    expect(serverModule.hasActiveSseFor('cc-offline')).toBe(true);

    offline.close();
    serverModule.unregisterCcId('cc-offline');
  });
});
