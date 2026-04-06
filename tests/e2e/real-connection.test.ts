/**
 * 真实连接集成测试
 *
 * 使用真实的 Bot ID 和 Secret 进行测试
 * 需要在 tests/.env.test 中配置 TEST_BOT_ID, TEST_SECRET, TEST_TARGET_USER
 *
 * 运行方式: RUN_E2E=true npm run test:e2e
 */

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
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

// 检查是否配置了测试凭证
const hasTestCredentials = TEST_CONFIG.botId && TEST_CONFIG.secret && TEST_CONFIG.targetUserId;

// 动态导入，避免在没有凭证时报错
const runRealTests = hasTestCredentials && process.env.RUN_E2E === 'true';

// 跳过条件
const describeIf = runRealTests ? describe : describe.skip;

describeIf('真实连接集成测试', () => {
  let WecomClient: typeof import('../../src/client').WecomClient;
  let client: InstanceType<typeof WecomClient>;

  beforeAll(async () => {
    const module = await import('../../src/client');
    WecomClient = module.WecomClient;
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    if (client) {
      client.disconnect();
    }
  });

  describe('WC-REAL-001: WebSocket 连接', () => {
    it('应该能成功连接到企业微信', async () => {
      client = new WecomClient(
        TEST_CONFIG.botId,
        TEST_CONFIG.secret,
        TEST_CONFIG.targetUserId,
        TEST_CONFIG.robotName
      );

      client.connect();

      // 等待连接建立
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('连接超时'));
        }, 10000);

        const checkConnected = () => {
          if (client.isConnected()) {
            clearTimeout(timeout);
            resolve();
          } else {
            setTimeout(checkConnected, 500);
          }
        };
        checkConnected();
      });

      expect(client.isConnected()).toBe(true);
    }, 15000);
  });

  describe('WC-REAL-002: 发送消息', () => {
    it('应该能发送文本消息', async () => {
      client = new WecomClient(
        TEST_CONFIG.botId,
        TEST_CONFIG.secret,
        TEST_CONFIG.targetUserId,
        TEST_CONFIG.robotName
      );

      client.connect();

      // 等待连接
      await new Promise<void>((resolve) => {
        const check = () => {
          if (client.isConnected()) resolve();
          else setTimeout(check, 500);
        };
        check();
      });

      const result = await client.sendText(`【测试】集成测试消息 - ${new Date().toISOString()}`);
      expect(result).toBe(true);
    }, 15000);
  });

  describe('WC-REAL-003: 发送审批请求', () => {
    it('应该能发送审批请求', async () => {
      client = new WecomClient(
        TEST_CONFIG.botId,
        TEST_CONFIG.secret,
        TEST_CONFIG.targetUserId,
        TEST_CONFIG.robotName
      );

      client.connect();

      // 等待连接
      await new Promise<void>((resolve) => {
        const check = () => {
          if (client.isConnected()) resolve();
          else setTimeout(check, 500);
        };
        check();
      });

      const taskId = await client.sendApprovalRequest(
        '【测试】集成测试审批',
        `测试审批请求 - ${new Date().toISOString()}`,
        'test-001'
      );

      expect(taskId).toContain('approval_');
    }, 15000);
  });

  describe('WC-REAL-004: 审批状态', () => {
    it('应该能查询审批状态', async () => {
      client = new WecomClient(
        TEST_CONFIG.botId,
        TEST_CONFIG.secret,
        TEST_CONFIG.targetUserId,
        TEST_CONFIG.robotName
      );

      client.connect();

      // 等待连接
      await new Promise<void>((resolve) => {
        const check = () => {
          if (client.isConnected()) resolve();
          else setTimeout(check, 500);
        };
        check();
      });

      const taskId = await client.sendApprovalRequest(
        '【测试】审批状态测试',
        `测试审批状态查询 - ${new Date().toISOString()}`,
        'test-002'
      );

      const result = client.getApprovalResult(taskId);
      expect(result).toBe('pending');
    }, 15000);
  });
});

// 空测试套件，当没有配置凭证时显示提示
!runRealTests && describe('真实连接集成测试 (跳过)', () => {
  it('需要配置 TEST_BOT_ID, TEST_SECRET, TEST_TARGET_USER 并设置 RUN_E2E=true', () => {
    console.log('要运行真实连接测试，请:');
    console.log('1. 在 tests/.env.test 中配置测试凭证');
    console.log('2. 运行: RUN_E2E=true npm run test:e2e');
    expect(true).toBe(true);
  });
});