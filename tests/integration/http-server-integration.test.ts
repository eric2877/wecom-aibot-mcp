/**
 * HTTP 服务器集成测试
 *
 * 启动真实 HTTP 服务器进行测试
 * 不使用 mock，测试真实行为
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// 配置目录
const CONFIG_DIR = path.join(os.homedir(), '.wecom-aibot-mcp');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

// HTTP 端口 - 使用不同端口避免冲突
const TEST_PORT = 18965;

// 辅助函数：发送 HTTP 请求
function httpRequest(options: http.RequestOptions, body?: string): Promise<{ status: number; data: any; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({
            status: res.statusCode || 0,
            data: data ? JSON.parse(data) : null,
            headers: res.headers
          });
        } catch {
          resolve({ status: res.statusCode || 0, data, headers: res.headers });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

describe('HTTP 服务器集成测试', () => {
  let serverModule: typeof import('../../src/http-server');

  beforeAll(async () => {
    if (!fs.existsSync(CONFIG_DIR)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
    }

    fs.writeFileSync(CONFIG_FILE, JSON.stringify({
      botId: 'test-bot-id',
      secret: 'test-secret',
      targetUserId: 'test-user'
    }));

    serverModule = await import('../../src/http-server.js');

    await serverModule.startHttpServer(TEST_PORT);
  });

  afterAll(() => {
    serverModule.stopHttpServer();

    if (fs.existsSync(CONFIG_FILE)) {
      fs.unlinkSync(CONFIG_FILE);
    }
  });

  describe('HS-INT-001: ccId 管理', () => {
    afterEach(() => {
      serverModule.unregisterActiveCcId('test-cc-1');
      serverModule.unregisterActiveCcId('test-cc-2');
      serverModule.unregisterActiveCcId('test-cc-3');
    });

    it('应该能生成唯一的 ccId', () => {
      const ccId1 = serverModule.generateCcId();
      const ccId2 = serverModule.generateCcId();

      expect(ccId1).toMatch(/^cc-\d+$/);
      expect(ccId2).toMatch(/^cc-\d+$/);
      expect(ccId1).not.toBe(ccId2);
    });

    it('应该能注册和注销 ccId', () => {
      serverModule.registerActiveCcId('test-cc-1');
      expect(serverModule.hasActiveHeadlessSession()).toBe(true);

      serverModule.unregisterActiveCcId('test-cc-1');
      expect(serverModule.hasActiveHeadlessSession()).toBe(false);
    });

    it('getFirstActiveCcId 应该返回第一个活跃 ccId', () => {
      serverModule.registerActiveCcId('test-cc-2');
      const first = serverModule.getFirstActiveCcId();
      expect(first).not.toBeNull();
      expect(first?.ccId).toBe('test-cc-2');

      serverModule.unregisterActiveCcId('test-cc-2');
    });

    it('多 ccId 时 getFirstActiveCcId 应该返回第一个', () => {
      serverModule.registerActiveCcId('test-cc-2');
      serverModule.registerActiveCcId('test-cc-3');

      const first = serverModule.getFirstActiveCcId();
      expect(first).not.toBeNull();
      expect(first?.ccId).toBe('test-cc-2');

      serverModule.unregisterActiveCcId('test-cc-2');
      serverModule.unregisterActiveCcId('test-cc-3');
    });
  });

  describe('HS-INT-002: HTTP 端点测试', () => {
    it('GET /health 应该返回健康状态', async () => {
      const result = await httpRequest({
        hostname: '127.0.0.1',
        port: TEST_PORT,
        path: '/health',
        method: 'GET',
      });

      expect(result.status).toBe(200);
      expect(result.data.status).toBe('ok');
      expect(result.data).toHaveProperty('uptime');
      expect(result.data).toHaveProperty('websocket');
    });

    it('GET /state 应该返回连接状态和活跃 ccId', async () => {
      const result = await httpRequest({
        hostname: '127.0.0.1',
        port: TEST_PORT,
        path: '/state',
        method: 'GET',
      });

      expect(result.status).toBe(200);
      expect(result.data).toHaveProperty('connection');
      expect(result.data).toHaveProperty('activeCcIds');
      expect(Array.isArray(result.data.activeCcIds)).toBe(true);
    });

    it('POST /approve 无活跃 ccId 时应该返回 503', async () => {
      const result = await httpRequest(
        {
          hostname: '127.0.0.1',
          port: TEST_PORT,
          path: '/approve',
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        },
        JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'echo test' } })
      );

      expect(result.status).toBe(503);
      expect(result.data).toHaveProperty('error');
    });

    it('POST /notify 无活跃 ccId 时应该返回 503', async () => {
      const result = await httpRequest(
        {
          hostname: '127.0.0.1',
          port: TEST_PORT,
          path: '/notify',
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        },
        JSON.stringify({ title: 'Test', message: 'Test message' })
      );

      expect(result.status).toBe(503);
    });

    it('GET /approval_status/:taskId 应该返回 pending', async () => {
      const result = await httpRequest({
        hostname: '127.0.0.1',
        port: TEST_PORT,
        path: '/approval_status/test-task-123',
        method: 'GET',
      });

      expect(result.status).toBe(200);
      expect(result.data.status).toBe('pending');
    });

    it('OPTIONS 请求应该返回 200', async () => {
      const result = await httpRequest({
        hostname: '127.0.0.1',
        port: TEST_PORT,
        path: '/health',
        method: 'OPTIONS',
      });

      expect(result.status).toBe(200);
    });

    it('未知路径应该返回 404', async () => {
      const result = await httpRequest({
        hostname: '127.0.0.1',
        port: TEST_PORT,
        path: '/unknown-endpoint',
        method: 'GET',
      });

      expect(result.status).toBe(404);
      expect(result.data).toHaveProperty('error');
    });

    it('POST /trigger_keepalive 无活跃 ccId 应该返回 400', async () => {
      const result = await httpRequest(
        {
          hostname: '127.0.0.1',
          port: TEST_PORT,
          path: '/trigger_keepalive',
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        },
        '{}'
      );

      expect(result.status).toBe(400);
    });

    it('POST /push_notification 应该发送通知', async () => {
      const result = await httpRequest(
        {
          hostname: '127.0.0.1',
          port: TEST_PORT,
          path: '/push_notification',
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        },
        JSON.stringify({ method: 'test/method', params: { key: 'value' } })
      );

      expect(result.status).toBe(200);
      expect(result.data.success).toBe(true);
    });
  });

  describe('HS-INT-003: CORS 头', () => {
    it('响应应该包含 CORS 头', async () => {
      const result = await httpRequest({
        hostname: '127.0.0.1',
        port: TEST_PORT,
        path: '/health',
        method: 'GET',
      });

      expect(result.headers['access-control-allow-origin']).toBe('*');
      expect(result.headers['access-control-allow-methods']).toBeDefined();
    });
  });

  describe('HS-INT-004: 常量验证', () => {
    it('HTTP_PORT 常量应该是 18963', () => {
      expect(serverModule.HTTP_PORT).toBe(18963);
    });

    it('HOOK_SCRIPT_PATH 应该包含正确路径', () => {
      expect(serverModule.HOOK_SCRIPT_PATH).toContain('.wecom-aibot-mcp');
      expect(serverModule.HOOK_SCRIPT_PATH).toContain('permission-hook.sh');
    });
  });

  describe('HS-INT-005: 健康检查详情', () => {
    it('健康检查应该包含 headless 模式状态', async () => {
      const result = await httpRequest({
        hostname: '127.0.0.1',
        port: TEST_PORT,
        path: '/health',
        method: 'GET',
      });

      expect(result.data.headless).toHaveProperty('mode');
    });

    it('健康检查应该包含 websocket 状态', async () => {
      const result = await httpRequest({
        hostname: '127.0.0.1',
        port: TEST_PORT,
        path: '/health',
        method: 'GET',
      });

      expect(result.data.websocket).toHaveProperty('connected');
    });
  });

  describe('HS-INT-006: 状态查询返回活跃 ccId', () => {
    afterEach(() => {
      serverModule.unregisterActiveCcId('test-state-cc');
    });

    it('应该返回 activeCcIds 数组', async () => {
      serverModule.registerActiveCcId('test-state-cc');

      const result = await httpRequest({
        hostname: '127.0.0.1',
        port: TEST_PORT,
        path: '/state',
        method: 'GET',
      });

      expect(result.status).toBe(200);
      expect(result.data.activeCcIds.some((c: any) => c.ccId === 'test-state-cc')).toBe(true);

      serverModule.unregisterActiveCcId('test-state-cc');
    });
  });

  describe('HS-INT-007: 调试端点', () => {
    it('GET /debug/ccids 应该返回活跃 ccId 列表', async () => {
      serverModule.registerActiveCcId('test-debug-cc');

      const result = await httpRequest({
        hostname: '127.0.0.1',
        port: TEST_PORT,
        path: '/debug/ccids',
        method: 'GET',
      });

      expect(result.status).toBe(200);
      expect(result.data).toHaveProperty('activeCcIds');
      expect(Array.isArray(result.data.activeCcIds)).toBe(true);

      serverModule.unregisterActiveCcId('test-debug-cc');
    });
  });
});
