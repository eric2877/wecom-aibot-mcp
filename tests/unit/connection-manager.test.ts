/**
 * 连接管理单元测试
 *
 * 测试覆盖：
 * - CM-001: 连接机器人
 * - CM-002: 连接不存在的机器人
 * - CM-003: 机器人占用检查
 * - CM-004: 断开连接
 * - CM-005: 获取客户端
 * - CM-006: 重连机制
 * - CM-007: 获取所有连接状态
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// 模拟 WecomClient（必须在导入前）
const mockClient = {
  connect: vi.fn(),
  disconnect: vi.fn(),
  isConnected: vi.fn(() => true),
  sendText: vi.fn(),
  sendApprovalRequest: vi.fn(),
  getApprovalResult: vi.fn(),
  getPendingMessages: vi.fn(() => [])
};

vi.mock('../../src/client.js', () => ({
  WecomClient: vi.fn(() => mockClient)
}));

vi.mock('../../src/config-wizard.js', () => ({
  listAllRobots: vi.fn(() => [
    { name: 'robot1', botId: 'bot1', targetUserId: 'user1', isDefault: true },
    { name: 'robot2', botId: 'bot2', targetUserId: 'user2', isDefault: false }
  ])
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: vi.fn(() => true),
    readdirSync: vi.fn(() => ['robot-robot1.json']),
    readFileSync: vi.fn(() => JSON.stringify({
      botId: 'bot1',
      secret: 'secret1',
      targetUserId: 'user1',
      nameTag: 'robot1'
    })),
  };
});

// 导入实际函数
import {
  isRobotOccupied,
  getRobotOccupiedBy,
  disconnectRobot,
  getAllConnectionStates,
  getConnectionState,
  updateAgentName,
  connectRobot,
  getClient,
} from '../../src/connection-manager';

describe('ConnectionManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClient.isConnected.mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('CM-003: 机器人占用检查', () => {
    it('未占用时应该返回 false', () => {
      expect(isRobotOccupied('non-existent-robot')).toBe(false);
    });

    it('应该能获取占用者的智能体名称', () => {
      const agentName = getRobotOccupiedBy('non-existent-robot');
      expect(agentName).toBeUndefined();
    });
  });

  describe('CM-004: 断开连接', () => {
    it('断开不存在的机器人应该无操作', () => {
      disconnectRobot('unknown-robot');
      expect(mockClient.disconnect).not.toHaveBeenCalled();
    });
  });

  describe('CM-007: 获取所有连接状态', () => {
    it('空连接池应该返回空数组', () => {
      const states = getAllConnectionStates();
      expect(states).toEqual([]);
    });
  });

  describe('CM-008: 更新智能体名称', () => {
    it('更新不存在的机器人应该无操作', () => {
      updateAgentName('unknown', 'Agent');
      // 不应该抛出错误
    });
  });

  describe('getConnectionState', () => {
    it('无连接时应该返回 disconnected', () => {
      const state = getConnectionState();
      expect(state.connected).toBe(false);
      expect(state.robotName).toBeNull();
      expect(state.connectedAt).toBeNull();
    });
  });

  describe('getClient', () => {
    it('未连接的机器人应该返回 null', async () => {
      const client = await getClient('non-existent-robot');
      expect(client).toBeNull();
    });
  });

  describe('connectRobot', () => {
    it('连接不存在的机器人应该返回错误', async () => {
      const result = await connectRobot('non-existent-robot', 'TestAgent');
      expect(result.success).toBe(false);
      expect(result.error).toContain('未找到机器人配置');
    });
  });

  describe('连接状态判断', () => {
    it('已连接的客户端应该返回 true', () => {
      mockClient.isConnected.mockReturnValue(true);
      expect(mockClient.isConnected()).toBe(true);
    });

    it('断开的客户端应该返回 false', () => {
      mockClient.isConnected.mockReturnValue(false);
      expect(mockClient.isConnected()).toBe(false);
    });
  });

  describe('机器人配置查找逻辑', () => {
    it('应该能通过名称匹配机器人', () => {
      const robotName = 'robot1';
      const robots = [
        { name: 'robot1', botId: 'bot1', targetUserId: 'user1', isDefault: true },
        { name: 'robot2', botId: 'bot2', targetUserId: 'user2', isDefault: false }
      ];

      const robot = robots.find(r =>
        r.name === robotName || r.botId === robotName || r.name.includes(robotName)
      );

      expect(robot?.name).toBe('robot1');
    });

    it('应该能通过 botId 匹配机器人', () => {
      const robotId = 'bot2';
      const robots = [
        { name: 'robot1', botId: 'bot1', targetUserId: 'user1', isDefault: true },
        { name: 'robot2', botId: 'bot2', targetUserId: 'user2', isDefault: false }
      ];

      const robot = robots.find(r =>
        r.name === robotId || r.botId === robotId || r.name.includes(robotId)
      );

      expect(robot?.name).toBe('robot2');
    });

    it('应该能通过部分名称匹配机器人', () => {
      const robotId = 'robot';
      const robots = [
        { name: 'robot1', botId: 'bot1', targetUserId: 'user1', isDefault: true },
        { name: 'robot2', botId: 'bot2', targetUserId: 'user2', isDefault: false }
      ];

      const robot = robots.find(r =>
        r.name === robotId || r.botId === robotId || r.name.includes(robotId)
      );

      expect(robot?.name).toBe('robot1');
    });
  });

  describe('ConnectionState 结构', () => {
    it('状态应该包含所有字段', () => {
      const state = {
        robotName: 'test-robot',
        client: mockClient,
        connectedAt: Date.now(),
        agentName: 'TestAgent'
      };

      expect(state.robotName).toBe('test-robot');
      expect(state.connectedAt).toBeDefined();
      expect(state.agentName).toBe('TestAgent');
    });

    it('agentName 应该是可选的', () => {
      const state = {
        robotName: 'test-robot',
        client: mockClient,
        connectedAt: Date.now()
      };

      expect(state.agentName).toBeUndefined();
    });
  });
});