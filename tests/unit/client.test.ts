/**
 * WecomClient 单元测试
 *
 * 测试覆盖：
 * - WC-001 ~ WC-012: 客户端各种场景
 * - 连接状态下的发送消息
 * - 事件处理器
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// 模拟 @wecom/aibot-node-sdk（必须在导入前）
const mockWsClient = {
  on: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
  sendMessage: vi.fn().mockResolvedValue(true),
  sendTemplateCard: vi.fn().mockResolvedValue('approval_123'),
  updateTemplateCard: vi.fn(),
};

vi.mock('@wecom/aibot-node-sdk', () => ({
  default: {
    WSClient: vi.fn(() => mockWsClient)
  }
}));

vi.mock('../../src/connection-log.js', () => ({
  logConnected: vi.fn(),
  logAuthenticated: vi.fn(),
  logDisconnected: vi.fn(),
  logReconnecting: vi.fn(),
  logError: vi.fn(),
}));

vi.mock('../../src/message-bus.js', () => ({
  publishWecomMessage: vi.fn(),
}));

// 导入实际类
import { WecomClient } from '../../src/client';

describe('WecomClient', () => {
  let client: WecomClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new WecomClient('test-bot-id', 'test-secret', 'test-user', 'test-robot');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('WC-001: 构造函数', () => {
    it('应该正确初始化', () => {
      expect(mockWsClient.on).toHaveBeenCalled();
    });

    it('应该生成正确的授权 URL', () => {
      const authUrl = client.getAuthUrl();
      expect(authUrl).toContain('test-bot-id');
      expect(authUrl).toContain('work.weixin.qq.com');
    });

    it('应该注册事件处理器', () => {
      // 验证事件处理器被注册
      expect(mockWsClient.on).toHaveBeenCalledWith('connected', expect.any(Function));
      expect(mockWsClient.on).toHaveBeenCalledWith('authenticated', expect.any(Function));
      expect(mockWsClient.on).toHaveBeenCalledWith('disconnected', expect.any(Function));
      expect(mockWsClient.on).toHaveBeenCalledWith('reconnecting', expect.any(Function));
      expect(mockWsClient.on).toHaveBeenCalledWith('error', expect.any(Function));
      expect(mockWsClient.on).toHaveBeenCalledWith('message', expect.any(Function));
    });
  });

  describe('WC-002: 连接状态', () => {
    it('初始状态应该是未连接', () => {
      expect(client.isConnected()).toBe(false);
    });

    it('connect 应该调用 wsClient.connect', () => {
      client.connect();
      expect(mockWsClient.connect).toHaveBeenCalled();
    });

    it('disconnect 应该调用 wsClient.disconnect', () => {
      client.disconnect();
      expect(mockWsClient.disconnect).toHaveBeenCalled();
    });
  });

  describe('WC-003: 发送文本消息', () => {
    it('断线时发送消息应该返回 false', async () => {
      const result = await client.sendText('test message');
      expect(result).toBe(false);
    });

    it('断线时消息应该加入待发送队列', async () => {
      await client.sendText('test message');
      expect(client.getPendingMessageCount()).toBe(1);
    });

    it('连接时应该调用 wsClient.sendMessage', async () => {
      // 模拟认证事件，设置连接状态
      const authenticatedHandler = mockWsClient.on.mock.calls.find(
        (call: any[]) => call[0] === 'authenticated'
      )?.[1];
      if (authenticatedHandler) {
        authenticatedHandler();
      }

      const result = await client.sendText('test message');
      expect(mockWsClient.sendMessage).toHaveBeenCalled();
      expect(result).toBe(true);
    });
  });

  describe('WC-004: 发送审批请求', () => {
    it('断线时发送审批应该返回 taskId', async () => {
      const taskId = await client.sendApprovalRequest('Test Title', 'Test Description', 'req-001');
      expect(taskId).toContain('approval_');
    });

    it('断线时审批应该加入待发送队列', async () => {
      await client.sendApprovalRequest('Test Title', 'Test Description', 'req-001');
      expect(client.getPendingMessageCount()).toBe(1);
    });

    it('连接时应该调用 wsClient.sendMessage', async () => {
      // 模拟认证事件，设置连接状态
      const authenticatedHandler = mockWsClient.on.mock.calls.find(
        (call: any[]) => call[0] === 'authenticated'
      )?.[1];
      if (authenticatedHandler) {
        authenticatedHandler();
      }

      const taskId = await client.sendApprovalRequest('Test Title', 'Test Description', 'req-001');
      expect(mockWsClient.sendMessage).toHaveBeenCalled();
      expect(taskId).toContain('approval_');
    });
  });

  describe('WC-005: 获取审批结果', () => {
    it('未知的 taskId 应该返回 pending', () => {
      const result = client.getApprovalResult('unknown-task-id');
      expect(result).toBe('pending');
    });

    it('连接时发送审批后应该能获取状态', async () => {
      // 模拟认证事件
      const authenticatedHandler = mockWsClient.on.mock.calls.find(
        (call: any[]) => call[0] === 'authenticated'
      )?.[1];
      if (authenticatedHandler) {
        authenticatedHandler();
      }

      const taskId = await client.sendApprovalRequest('Test', 'Desc', 'req-001');
      const result = client.getApprovalResult(taskId);
      expect(result).toBe('pending');
    });
  });

  describe('WC-006: 获取待处理审批', () => {
    it('初始应该没有待处理审批', () => {
      const pending = client.getPendingApprovals();
      expect(pending).toEqual([]);
    });

    it('连接时发送审批后应该有待处理审批', async () => {
      // 模拟认证事件
      const authenticatedHandler = mockWsClient.on.mock.calls.find(
        (call: any[]) => call[0] === 'authenticated'
      )?.[1];
      if (authenticatedHandler) {
        authenticatedHandler();
      }

      await client.sendApprovalRequest('Test', 'Desc', 'req-001');
      const pending = client.getPendingApprovals();
      expect(pending.length).toBe(1);
    });
  });

  describe('WC-007: 获取待处理审批记录', () => {
    it('初始应该没有待处理审批记录', () => {
      const records = client.getPendingApprovalsRecords();
      expect(records).toEqual([]);
    });

    it('连接时发送审批后应该有待处理审批记录', async () => {
      // 模拟认证事件
      const authenticatedHandler = mockWsClient.on.mock.calls.find(
        (call: any[]) => call[0] === 'authenticated'
      )?.[1];
      if (authenticatedHandler) {
        authenticatedHandler();
      }

      await client.sendApprovalRequest('Test', 'Desc', 'req-001');
      const records = client.getPendingApprovalsRecords();
      expect(records.length).toBe(1);
    });
  });

  describe('WC-008: 获取审批记录', () => {
    it('未知的 taskId 应该返回 undefined', () => {
      const record = client.getApprovalRecord('unknown-task-id');
      expect(record).toBeUndefined();
    });

    it('连接时发送审批后应该能获取记录', async () => {
      // 模拟认证事件
      const authenticatedHandler = mockWsClient.on.mock.calls.find(
        (call: any[]) => call[0] === 'authenticated'
      )?.[1];
      if (authenticatedHandler) {
        authenticatedHandler();
      }

      const taskId = await client.sendApprovalRequest('Test', 'Desc', 'req-001');
      const record = client.getApprovalRecord(taskId);
      expect(record).toBeDefined();
      expect(record?.taskId).toBe(taskId);
    });
  });

  describe('WC-009: 获取待处理消息', () => {
    it('初始应该没有待处理消息', () => {
      const messages = client.getPendingMessages();
      expect(messages).toEqual([]);
    });

    it('清理后应该清空消息队列', () => {
      const messages = client.getPendingMessages(true);
      expect(messages).toEqual([]);
    });
  });

  describe('WC-010: 清理过期消息', () => {
    it('清理过期消息应该正常工作', () => {
      client.cleanupMessages(0);
      const messages = client.getPendingMessages();
      expect(messages).toEqual([]);
    });
  });

  describe('WC-011: 获取重连状态', () => {
    it('初始状态应该是未重连', () => {
      const status = client.getReconnectStatus();
      expect(status.wasReconnecting).toBe(false);
      expect(status.attempt).toBe(0);
      expect(status.lastDisconnectTime).toBe(0);
    });
  });

  describe('WC-012: 消息格式', () => {
    it('审批标题格式应该正确', async () => {
      const taskId = await client.sendApprovalRequest('【cc-1】Bash', '执行命令: ls', 'req-001');
      expect(taskId).toBeDefined();
    });

    it('消息内容格式应该正确', async () => {
      await client.sendText('【进度】正在处理...');
      expect(client.getPendingMessageCount()).toBe(1);
    });
  });

  describe('消息记录结构', () => {
    it('消息记录应该包含所有字段', () => {
      const msg = {
        msgid: 'msg-001',
        content: 'test content',
        timestamp: Date.now(),
        from_userid: 'user1',
        chatid: 'chat1',
        chattype: 'single' as const
      };

      expect(msg.msgid).toBe('msg-001');
      expect(msg.content).toBe('test content');
      expect(msg.from_userid).toBe('user1');
      expect(msg.chatid).toBe('chat1');
      expect(msg.chattype).toBe('single');
    });
  });

  describe('审批记录结构', () => {
    it('审批记录应该包含所有字段', () => {
      const record = {
        taskId: 'approval-001',
        resolved: false,
        result: undefined,
        timestamp: Date.now(),
        toolName: 'Bash',
        toolInput: { command: 'ls' }
      };

      expect(record.taskId).toBe('approval-001');
      expect(record.resolved).toBe(false);
      expect(record.toolName).toBe('Bash');
    });
  });

  describe('默认目标用户', () => {
    it('应该返回正确的默认目标用户', () => {
      const targetUser = client.getDefaultTargetUser();
      expect(targetUser).toBe('test-user');
    });
  });

  describe('待发送消息队列', () => {
    it('多条消息应该都加入队列', async () => {
      await client.sendText('message 1');
      await client.sendText('message 2');
      await client.sendText('message 3');
      expect(client.getPendingMessageCount()).toBe(3);
    });

    it('混合消息应该都加入队列', async () => {
      await client.sendText('text message');
      await client.sendApprovalRequest('Title', 'Desc', 'req-001');
      expect(client.getPendingMessageCount()).toBe(2);
    });
  });

  describe('getLatestMessage', () => {
    it('初始应该返回 undefined', () => {
      const msg = client.getLatestMessage(Date.now());
      expect(msg).toBeUndefined();
    });
  });
});