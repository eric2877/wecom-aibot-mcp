/**
 * HTTP 服务器 E2E 测试
 *
 * 使用真实凭证测试 HTTP 端点
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import * as http from 'http';

// ESM 环境下获取 __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 加载测试环境变量
const envPath = path.join(__dirname, '../.env.test');
const envContent = fs.readFileSync(envPath, 'utf-8');
envContent.split('\n').forEach(line => {
  const match = line.match(/^([^#=]+)=(.*)$/);
  if (match && !line.startsWith('#')) {
    const key = match[1].trim();
    const value = match[2].trim();
    process.env[key] = value;
  }
});

const TEST_CONFIG = {
  botId: process.env.TEST_BOT_ID || '',
  secret: process.env.TEST_SECRET || '',
  targetUserId: process.env.TEST_TARGET_USER || '',
  robotName: process.env.TEST_ROBOT_NAME || 'TestRobot',
};

const hasTestCredentials = TEST_CONFIG.botId && TEST_CONFIG.secret && TEST_CONFIG.targetUserId;
const runE2E = hasTestCredentials && process.env.RUN_E2E === 'true';
const describeIf = runE2E ? describe : describe.skip;

const HTTP_PORT = 18963;

async function httpRequest(options: http.RequestOptions, body?: string): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode || 0, data: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode || 0, data });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

describeIf('HTTP 服务器 E2E 测试', () => {
  describe('HS-E2E-001: 健康检查', () => {
    it('GET /health 应该返回 200', async () => {
      const result = await httpRequest({
        hostname: '127.0.0.1',
        port: HTTP_PORT,
        path: '/health',
        method: 'GET',
      });

      expect(result.status).toBe(200);
      expect(result.data.status).toBe('ok');
    });
  });

  describe('HS-E2E-002: 状态查询', () => {
    it('GET /state 应该返回连接状态', async () => {
      const result = await httpRequest({
        hostname: '127.0.0.1',
        port: HTTP_PORT,
        path: '/state',
        method: 'GET',
      });

      expect(result.status).toBe(200);
      expect(result.data).toHaveProperty('connection');
    });
  });

  describe('HS-E2E-003: 审批请求', () => {
    it('POST /approve 应该返回 taskId', async () => {
      const result = await httpRequest(
        {
          hostname: '127.0.0.1',
          port: HTTP_PORT,
          path: '/approve',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
        },
        JSON.stringify({
          tool_name: 'Bash',
          tool_input: { command: 'echo test' },
        })
      );

      expect(result.status).toBe(200);
      expect(result.data).toHaveProperty('taskId');
    });
  });

  describe('HS-E2E-004: 审批状态查询', () => {
    it('GET /approval_status/:taskId 应该返回状态', async () => {
      const result = await httpRequest({
        hostname: '127.0.0.1',
        port: HTTP_PORT,
        path: '/approval_status/test-task-123',
        method: 'GET',
      });

      expect(result.status).toBe(200);
      expect(result.data).toHaveProperty('status');
    });
  });
});

!runE2E && describe('HTTP 服务器 E2E 测试 (跳过)', () => {
  it('需要设置 RUN_E2E=true', () => {
    expect(true).toBe(true);
  });
});