/**
 * 完整流程 E2E 测试
 *
 * 测试从进入微信模式到发送消息的完整流程
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

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

describeIf('完整流程 E2E 测试', () => {
  let client: any;
  let WecomClient: any;

  beforeAll(async () => {
    const module = await import('../../src/client');
    WecomClient = module.WecomClient;
  });

  afterAll(() => {
    if (client) {
      client.disconnect();
    }
  });

  describe('E2E-001: 完整消息流程', () => {
    it('应该能完成连接->发送->断开的完整流程', async () => {
      // 1. 创建客户端
      client = new WecomClient(
        TEST_CONFIG.botId,
        TEST_CONFIG.secret,
        TEST_CONFIG.targetUserId,
        TEST_CONFIG.robotName
      );

      expect(client).toBeDefined();
      expect(client.isConnected()).toBe(false);

      // 2. 连接
      client.connect();

      // 等待连接
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('连接超时')), 15000);
        const check = () => {
          if (client.isConnected()) {
            clearTimeout(timeout);
            resolve();
          } else {
            setTimeout(check, 500);
          }
        };
        check();
      });

      expect(client.isConnected()).toBe(true);

      // 3. 发送消息
      const result = await client.sendText(`【E2E测试】完整流程测试 - ${new Date().toISOString()}`);
      expect(result).toBe(true);

      // 4. 断开连接
      client.disconnect();
      expect(client.isConnected()).toBe(false);
    }, 30000);
  });

  describe('E2E-002: 审批流程', () => {
    beforeAll(async () => {
      client = new WecomClient(
        TEST_CONFIG.botId,
        TEST_CONFIG.secret,
        TEST_CONFIG.targetUserId,
        TEST_CONFIG.robotName
      );
      client.connect();

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('连接超时')), 15000);
        const check = () => {
          if (client.isConnected()) {
            clearTimeout(timeout);
            resolve();
          } else {
            setTimeout(check, 500);
          }
        };
        check();
      });
    });

    afterAll(() => {
      if (client) client.disconnect();
    });

    it('应该能发送审批请求', async () => {
      const taskId = await client.sendApprovalRequest(
        '【E2E测试】审批测试',
        `测试审批请求 - ${new Date().toISOString()}`,
        'e2e-approval-001'
      );

      expect(taskId).toContain('approval_');
    });

    it('应该能查询审批状态', async () => {
      const taskId = await client.sendApprovalRequest(
        '【E2E测试】审批状态测试',
        `测试审批状态 - ${new Date().toISOString()}`,
        'e2e-approval-002'
      );

      const result = client.getApprovalResult(taskId);
      expect(result).toBe('pending');
    });

    it('应该能获取待处理审批列表', async () => {
      await client.sendApprovalRequest(
        '【E2E测试】待处理列表测试',
        `测试待处理列表 - ${new Date().toISOString()}`,
        'e2e-approval-003'
      );

      const pending = client.getPendingApprovals();
      expect(pending.length).toBeGreaterThan(0);
    });
  });

  describe('E2E-003: 重连测试', () => {
    it('断线后应该能重连', async () => {
      client = new WecomClient(
        TEST_CONFIG.botId,
        TEST_CONFIG.secret,
        TEST_CONFIG.targetUserId,
        TEST_CONFIG.robotName
      );

      // 首次连接
      client.connect();
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('首次连接超时')), 15000);
        const check = () => {
          if (client.isConnected()) {
            clearTimeout(timeout);
            resolve();
          } else {
            setTimeout(check, 500);
          }
        };
        check();
      });

      expect(client.isConnected()).toBe(true);

      // 断开
      client.disconnect();
      expect(client.isConnected()).toBe(false);

      // 重连
      client.connect();
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('重连超时')), 15000);
        const check = () => {
          if (client.isConnected()) {
            clearTimeout(timeout);
            resolve();
          } else {
            setTimeout(check, 500);
          }
        };
        check();
      });

      expect(client.isConnected()).toBe(true);
    }, 45000);
  });
});

!runE2E && describe('完整流程 E2E 测试 (跳过)', () => {
  it('需要设置 RUN_E2E=true 并配置测试凭证', () => {
    console.log('运行 E2E 测试:');
    console.log('1. 确保 tests/.env.test 中有正确的配置');
    console.log('2. 运行: RUN_E2E=true npm run test:e2e');
    expect(true).toBe(true);
  });
});