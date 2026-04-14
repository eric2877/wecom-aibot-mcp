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
const CONFIG_FILE = path.join(CONFIG_DIR, 'robot-test-integration.json');

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
  const SERVER_CONFIG_FILE = path.join(CONFIG_DIR, 'server.json');

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

    // 确保没有 server.json（无 Auth Token）
    if (fs.existsSync(SERVER_CONFIG_FILE)) {
      fs.unlinkSync(SERVER_CONFIG_FILE);
    }

    // 导入模块
    serverModule = await import('../../src/http-server.js');

    // 启动服务器（不等待 WebSocket 连接）
    const mockMcpServer = {
      server: { notification: async () => {} },
      connect: async () => {}
    };

    // 使用较短超时启动，WebSocket 连接会失败但不影响 HTTP 端点测试
    await serverModule.startHttpServer(mockMcpServer as any, TEST_PORT);
  }, 30000);

  afterAll(() => {
    // 停止服务器
    serverModule.stopHttpServer();

    // 清理配置
    if (fs.existsSync(CONFIG_FILE)) {
      fs.unlinkSync(CONFIG_FILE);
    }

    // 清理 server.json
    if (fs.existsSync(SERVER_CONFIG_FILE)) {
      fs.unlinkSync(SERVER_CONFIG_FILE);
    }
  });

  describe('HS-INT-001: CC Registry 管理', () => {
    afterEach(() => {
      // 清理所有测试 CCID
      const onlineCcIds = serverModule.getOnlineCcIds();
      for (const ccId of onlineCcIds) {
        if (ccId.startsWith('cc-test-')) {
          serverModule.unregisterCcId(ccId);
        }
      }
    });

    it('应该能注册和查询 CCID', () => {
      serverModule.registerCcId('cc-test-1', 'test-robot', 'test-agent');

      expect(serverModule.getCCRegistryEntry('cc-test-1')).not.toBeNull();
      expect(serverModule.getRobotByCcId('cc-test-1')).toBe('test-robot');

      const entry = serverModule.getCCRegistryEntry('cc-test-1');
      expect(entry?.robotName).toBe('test-robot');
      expect(entry?.agentName).toBe('test-agent');
    });

    it('应该能注销 CCID', () => {
      serverModule.registerCcId('cc-test-2', 'test-robot');

      expect(serverModule.getCCRegistryEntry('cc-test-2')).not.toBeNull();

      serverModule.unregisterCcId('cc-test-2');

      expect(serverModule.getCCRegistryEntry('cc-test-2')).toBeNull();
      expect(serverModule.getRobotByCcId('cc-test-2')).toBeNull();
    });

    it('应该能获取 CC 总数', () => {
      serverModule.registerCcId('cc-test-3', 'robot-1');
      serverModule.registerCcId('cc-test-4', 'robot-2');

      expect(serverModule.getCCCount()).toBeGreaterThanOrEqual(2);
    });

    it('应该能按机器人统计 CC 数量', () => {
      serverModule.registerCcId('cc-test-5', 'robot-stats');
      serverModule.registerCcId('cc-test-6', 'robot-stats');
      serverModule.registerCcId('cc-test-7', 'robot-other');

      expect(serverModule.getCCCountByRobot('robot-stats')).toBeGreaterThanOrEqual(2);
      expect(serverModule.getCCCountByRobot('robot-other')).toBeGreaterThanOrEqual(1);
    });

    it('应该能获取在线 CCID 列表', () => {
      serverModule.registerCcId('cc-test-8', 'robot-list');

      const onlineCcIds = serverModule.getOnlineCcIds();
      expect(onlineCcIds).toContain('cc-test-8');
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
    });

    it('POST /approve 无 CCID 时应该返回 503', async () => {
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

    it('POST /notify 无 CCID 时应该返回 503', async () => {
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

    it('POST /trigger_keepalive 无 CCID 应该返回 400', async () => {
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

    it('POST /push_notification 无 CCID 时应该返回 503', async () => {
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

      expect(result.status).toBe(503);
      expect(result.data).toHaveProperty('error');
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
    it('状态查询应该返回 connection 对象', async () => {
      const result = await httpRequest({
        hostname: '127.0.0.1',
        port: TEST_PORT,
        path: '/state',
        method: 'GET',
      });

      expect(result.data).toHaveProperty('connection');
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

  describe('HS-INT-008: CC Registry 数据结构', () => {
    afterEach(() => {
      serverModule.unregisterCcId('cc-test-struct');
    });

    it('Registry 数据应该包含所有字段', () => {
      serverModule.registerCcId('cc-test-struct', 'test-robot', 'test-agent');

      const entry = serverModule.getCCRegistryEntry('cc-test-struct');
      expect(entry?.robotName).toBe('test-robot');
      expect(entry?.agentName).toBe('test-agent');
    });

    it('agentName 应该是可选的', () => {
      serverModule.registerCcId('cc-test-struct-2', 'test-robot');

      const entry = serverModule.getCCRegistryEntry('cc-test-struct-2');
      expect(entry?.agentName).toBeUndefined();

      serverModule.unregisterCcId('cc-test-struct-2');
    });
  });

  describe('HS-INT-010: Auth Token 校验', () => {
    const TEST_TOKEN = 'test-auth-token-12345';
    const SERVER_CONFIG_FILE = path.join(CONFIG_DIR, 'server.json');

    // 注意：这个测试组必须放在最后，因为它会动态改变 server.json
    // afterEach 会清理 server.json，确保不影响后续测试（如果有）

    beforeEach(() => {
      // 清理可能存在的旧 server.json
      if (fs.existsSync(SERVER_CONFIG_FILE)) {
        fs.unlinkSync(SERVER_CONFIG_FILE);
      }
      // 写入测试 token
      fs.writeFileSync(SERVER_CONFIG_FILE, JSON.stringify({ authToken: TEST_TOKEN }));
    });

    afterEach(() => {
      // 清理 server.json，确保无 token 状态
      if (fs.existsSync(SERVER_CONFIG_FILE)) {
        fs.unlinkSync(SERVER_CONFIG_FILE);
      }
    });

    afterAll(() => {
      // 确保测试组结束后 server.json 被清理
      if (fs.existsSync(SERVER_CONFIG_FILE)) {
        fs.unlinkSync(SERVER_CONFIG_FILE);
      }
    });

    it('/health 端点应该豁免 token 校验', async () => {
      const result = await httpRequest({
        hostname: '127.0.0.1',
        port: TEST_PORT,
        path: '/health',
        method: 'GET',
      });
      expect(result.status).toBe(200);
      expect(result.data.status).toBe('ok');
    });

    it('无 token 的请求应该返回 401', async () => {
      const result = await httpRequest({
        hostname: '127.0.0.1',
        port: TEST_PORT,
        path: '/state',
        method: 'GET',
      });
      expect(result.status).toBe(401);
      expect(result.data.error).toBe('Unauthorized');
    });

    it('无效 token 的请求应该返回 401', async () => {
      const result = await httpRequest({
        hostname: '127.0.0.1',
        port: TEST_PORT,
        path: '/state',
        method: 'GET',
        headers: { Authorization: 'Bearer wrong-token' },
      });
      expect(result.status).toBe(401);
      expect(result.data.error).toBe('Unauthorized');
    });

    it('有效 token 的请求应该成功', async () => {
      const result = await httpRequest({
        hostname: '127.0.0.1',
        port: TEST_PORT,
        path: '/state',
        method: 'GET',
        headers: { Authorization: `Bearer ${TEST_TOKEN}` },
      });
      expect(result.status).toBe(200);
      expect(result.data).toHaveProperty('connection');
    });

    it('OPTIONS 请求应该豁免 token 校验（CORS preflight）', async () => {
      const result = await httpRequest({
        hostname: '127.0.0.1',
        port: TEST_PORT,
        path: '/state',
        method: 'OPTIONS',
      });
      expect(result.status).toBe(200);
    });

    it('/skill 端点应该需要 token', async () => {
      // 无 token
      const resultNoToken = await httpRequest({
        hostname: '127.0.0.1',
        port: TEST_PORT,
        path: '/skill',
        method: 'GET',
      });
      expect(resultNoToken.status).toBe(401);

      // 有 token
      const resultWithToken = await httpRequest({
        hostname: '127.0.0.1',
        port: TEST_PORT,
        path: '/skill',
        method: 'GET',
        headers: { Authorization: `Bearer ${TEST_TOKEN}` },
      });
      // 可能返回 404（skill 文件不存在）或 200
      expect(resultWithToken.status).not.toBe(401);
    });
  });
});