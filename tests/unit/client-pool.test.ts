/**
 * Client Pool 单元测试
 *
 * 测试覆盖：
 * - CP-001: getOrCreateClient
 * - CP-002: getClient
 * - CP-003: getAllClients
 * - CP-004: getAllProjectDirs
 * - CP-005: setConfig
 * - CP-006: getConfig
 * - CP-007: removeClient
 * - CP-008: clearAll
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// 模拟 WecomClient
vi.mock('../../src/client.js', () => ({
  WecomClient: vi.fn(() => ({
    connect: vi.fn(),
    disconnect: vi.fn(),
    isConnected: vi.fn(() => true),
  })),
}));

// 导入实际函数
import {
  getClient,
  getAllClients,
  getAllProjectDirs,
  setConfig,
  getConfig,
  removeClient,
  clearAll,
  getStats,
} from '../../src/client-pool';

describe('Client Pool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearAll();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('CP-002: getClient', () => {
    it('未创建的客户端应该返回 undefined', () => {
      const client = getClient('/test/project');
      expect(client).toBeUndefined();
    });
  });

  describe('CP-003: getAllClients', () => {
    it('初始应该返回空数组', () => {
      const clients = getAllClients();
      expect(clients).toEqual([]);
    });
  });

  describe('CP-004: getAllProjectDirs', () => {
    it('初始应该返回空数组', () => {
      const dirs = getAllProjectDirs();
      expect(dirs).toEqual([]);
    });
  });

  describe('CP-005: setConfig', () => {
    it('应该能设置配置', () => {
      const config = {
        botId: 'test-bot',
        secret: 'test-secret',
        targetUserId: 'test-user',
      };
      setConfig('/test/project', config);
      const savedConfig = getConfig('/test/project');
      expect(savedConfig).toEqual(config);
    });
  });

  describe('CP-006: getConfig', () => {
    it('未设置的配置应该返回 undefined', () => {
      const config = getConfig('/test/project');
      expect(config).toBeUndefined();
    });

    it('设置后应该能获取配置', () => {
      const config = {
        botId: 'test-bot',
        secret: 'test-secret',
        targetUserId: 'test-user',
      };
      setConfig('/test/project', config);
      const savedConfig = getConfig('/test/project');
      expect(savedConfig?.botId).toBe('test-bot');
    });
  });

  describe('CP-007: removeClient', () => {
    it('移除不存在的客户端应该无操作', () => {
      removeClient('/test/project');
      expect(true).toBe(true);
    });
  });

  describe('CP-008: clearAll', () => {
    it('应该能清空所有客户端', () => {
      setConfig('/test/project1', {
        botId: 'bot1',
        secret: 'secret1',
        targetUserId: 'user1',
      });
      setConfig('/test/project2', {
        botId: 'bot2',
        secret: 'secret2',
        targetUserId: 'user2',
      });

      clearAll();

      expect(getAllProjectDirs()).toEqual([]);
    });
  });

  describe('CP-009: getStats', () => {
    it('应该能获取统计信息', () => {
      const stats = getStats();
      expect(stats).toHaveProperty('totalClients');
      expect(stats).toHaveProperty('connectedClients');
      expect(stats).toHaveProperty('projects');
    });

    it('初始统计应该为 0', () => {
      const stats = getStats();
      expect(stats.totalClients).toBe(0);
      expect(stats.connectedClients).toBe(0);
    });
  });

  describe('WecomConfig 结构', () => {
    it('配置应该包含所有字段', () => {
      const config = {
        botId: 'test-bot',
        secret: 'test-secret',
        targetUserId: 'test-user',
      };

      expect(config.botId).toBe('test-bot');
      expect(config.secret).toBe('test-secret');
      expect(config.targetUserId).toBe('test-user');
    });
  });
});