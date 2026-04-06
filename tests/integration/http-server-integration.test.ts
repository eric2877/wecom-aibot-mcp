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
    // 确保配置目录存在
    if (!fs.existsSync(CONFIG_DIR)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
    }

    // 写入测试配置
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({
      botId: 'test-bot-id',
      secret: 'test-secret',
      targetUserId: 'test-user'
    }));

    // 导入模块
    serverModule = await import('../../src/http-server.js');

    // 启动服务器
    const mockMcpServer = {
      server: { notification: async () => {} },
      connect: async () => {}
    };

    await serverModule.startHttpServer(mockMcpServer as any, TEST_PORT);
  });

  afterAll(() => {
    // 停止服务器
    serverModule.stopHttpServer();

    // 清理配置
    if (fs.existsSync(CONFIG_FILE)) {
      fs.unlinkSync(CONFIG_FILE);
    }
  });

  describe('HS-INT-001: Session 管理', () => {
    afterEach(() => {
      // 清理所有测试 Session
      serverModule.deleteSession('test-session-1');
      serverModule.deleteSession('test-session-2');
      serverModule.deleteSession('test-session-3');
      serverModule.deleteSession('test-session-4');
      serverModule.deleteSession('test-session-5');
    });

    it('应该能生成唯一的 ccId', () => {
      const ccId1 = serverModule.generateCcId();
      const ccId2 = serverModule.generateCcId();

      expect(ccId1).toMatch(/^cc-\d+$/);
      expect(ccId2).toMatch(/^cc-\d+$/);
      expect(ccId1).not.toBe(ccId2);
    });

    it('应该能设置和获取 Session', () => {
      serverModule.setSessionData('test-session-1', {
        robotName: 'test-robot',
        ccId: 'cc-100',
        createdAt: Date.now(),
      });

      const data = serverModule.getSessionData('test-session-1');
      expect(data).not.toBeNull();
      expect(data?.robotName).toBe('test-robot');
      expect(data?.ccId).toBe('cc-100');
    });

    it('应该能删除 Session', () => {
      serverModule.setSessionData('test-session-2', {
        robotName: 'test-robot',
        ccId: 'cc-101',
        createdAt: Date.now(),
      });

      expect(serverModule.getSessionData('test-session-2')).not.toBeNull();

      serverModule.deleteSession('test-session-2');

      expect(serverModule.getSessionData('test-session-2')).toBeNull();
    });

    it('hasActiveHeadlessSession 应该正确反映状态', () => {
      expect(serverModule.hasActiveHeadlessSession()).toBe(false);

      serverModule.setSessionData('test-session-3', {
        robotName: 'test-robot',
        ccId: 'cc-102',
        createdAt: Date.now(),
      });

      expect(serverModule.hasActiveHeadlessSession()).toBe(true);

      serverModule.deleteSession('test-session-3');

      expect(serverModule.hasActiveHeadlessSession()).toBe(false);
    });

    it('getFirstActiveSession 应该返回第一个活跃 Session', () => {
      serverModule.setSessionData('test-session-4', {
        robotName: 'robot-1',
        ccId: 'cc-103',
        createdAt: Date.now(),
      });

      const session = serverModule.getFirstActiveSession();
      expect(session).not.toBeNull();
      expect(session?.data.ccId).toBe('cc-103');
    });

    it('findSessionByRobotName 应该能查找 Session', () => {
      serverModule.setSessionData('test-session-5', {
        robotName: 'robot-find-test',
        ccId: 'cc-104',
        createdAt: Date.now(),
      });

      const sessionId = serverModule.findSessionByRobotName('robot-find-test');
      expect(sessionId).toBe('test-session-5');
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

    it('GET /state 应该返回连接状态', async () => {
      const result = await httpRequest({
        hostname: '127.0.0.1',
        port: TEST_PORT,
        path: '/state',
        method: 'GET',
      });

      expect(result.status).toBe(200);
      expect(result.data).toHaveProperty('connection');
      expect(result.data).toHaveProperty('sessions');
    });

    it('POST /approve 无 Session 时应该返回 503', async () => {
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

    it('POST /notify 无 Session 时应该返回 503', async () => {
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

    it('POST /trigger_keepalive 无 Session 应该返回 400', async () => {
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

  describe('HS-INT-006: 状态查询详情', () => {
    it('状态查询应该返回 sessions 数组', async () => {
      const result = await httpRequest({
        hostname: '127.0.0.1',
        port: TEST_PORT,
        path: '/state',
        method: 'GET',
      });

      expect(Array.isArray(result.data.sessions)).toBe(true);
    });
  });

  describe('HS-INT-007: 审批状态查询', () => {
    it('无效 taskId 应该返回 pending', async () => {
      const result = await httpRequest({
        hostname: '127.0.0.1',
        port: TEST_PORT,
        path: '/approval_status/invalid-task-id',
        method: 'GET',
      });

      expect(result.status).toBe(200);
      expect(result.data.status).toBe('pending');
    });
  });

  describe('HS-INT-008: Session 数据结构', () => {
    afterEach(() => {
      serverModule.deleteSession('test-struct-session');
    });

    it('Session 数据应该包含所有字段', () => {
      const now = Date.now();
      serverModule.setSessionData('test-struct-session', {
        robotName: 'test-robot',
        agentName: 'test-agent',
        ccId: 'cc-200',
        createdAt: now,
      });

      const data = serverModule.getSessionData('test-struct-session');
      expect(data?.robotName).toBe('test-robot');
      expect(data?.agentName).toBe('test-agent');
      expect(data?.ccId).toBe('cc-200');
      expect(data?.createdAt).toBe(now);
    });

    it('agentName 应该是可选的', () => {
      serverModule.setSessionData('test-struct-session', {
        robotName: 'test-robot',
        ccId: 'cc-201',
        createdAt: Date.now(),
      });

      const data = serverModule.getSessionData('test-struct-session');
      expect(data?.agentName).toBeUndefined();
    });
  });

  describe('HS-INT-009: 多 Session 管理', () => {
    afterEach(() => {
      serverModule.deleteSession('multi-session-1');
      serverModule.deleteSession('multi-session-2');
    });

    it('应该能管理多个 Session', () => {
      serverModule.setSessionData('multi-session-1', {
        robotName: 'robot-1',
        ccId: 'cc-300',
        createdAt: Date.now(),
      });

      serverModule.setSessionData('multi-session-2', {
        robotName: 'robot-2',
        ccId: 'cc-301',
        createdAt: Date.now(),
      });

      expect(serverModule.getSessionData('multi-session-1')?.robotName).toBe('robot-1');
      expect(serverModule.getSessionData('multi-session-2')?.robotName).toBe('robot-2');
      expect(serverModule.hasActiveHeadlessSession()).toBe(true);
    });

    it('删除一个 Session 不应该影响其他 Session', () => {
      serverModule.setSessionData('multi-session-1', {
        robotName: 'robot-1',
        ccId: 'cc-302',
        createdAt: Date.now(),
      });

      serverModule.setSessionData('multi-session-2', {
        robotName: 'robot-2',
        ccId: 'cc-303',
        createdAt: Date.now(),
      });

      serverModule.deleteSession('multi-session-1');

      expect(serverModule.getSessionData('multi-session-1')).toBeNull();
      expect(serverModule.getSessionData('multi-session-2')?.robotName).toBe('robot-2');
    });
  });
});