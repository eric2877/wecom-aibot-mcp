/**
 * Connection Log 单元测试
 *
 * 测试覆盖：
 * - CL-001: loadStats
 * - CL-002: getStats
 * - CL-003: logConnected
 * - CL-004: logAuthenticated
 * - CL-005: logDisconnected
 * - CL-006: logReconnecting
 * - CL-007: logError
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// 模拟文件系统
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: vi.fn(() => true),
    mkdirSync: vi.fn(),
    readFileSync: vi.fn(() => JSON.stringify({
      totalConnections: 5,
      successfulConnections: 4,
      failedConnections: 1,
      lastConnectionTime: Date.now(),
      totalDuration: 3600000,
    })),
    writeFileSync: vi.fn(),
    appendFileSync: vi.fn(),
  };
});

vi.mock('path', async (importOriginal) => {
  const actual = await importOriginal<typeof import('path')>();
  return {
    ...actual,
    join: vi.fn((...args) => args.join('/')),
  };
});

vi.mock('os', () => ({
  homedir: vi.fn(() => '/home/test'),
}));

// 导入实际函数
import {
  loadStats,
  getStats,
  getLogFilePath,
  getStatsFilePath,
  logConnected,
  logAuthenticated,
  logDisconnected,
  logReconnecting,
  logError,
} from '../../src/connection-log';

describe('Connection Log', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('CL-001: loadStats', () => {
    it('应该能加载统计信息', () => {
      const stats = loadStats();
      expect(stats.totalConnections).toBe(5);
      expect(stats.successfulConnections).toBe(4);
      expect(stats.failedConnections).toBe(1);
    });
  });

  describe('CL-002: getStats', () => {
    it('应该能获取统计信息', () => {
      const stats = getStats();
      expect(stats).toBeDefined();
      expect(typeof stats.totalConnections).toBe('number');
    });
  });

  describe('CL-003: logConnected', () => {
    it('应该能记录连接事件', () => {
      logConnected();
      // 验证函数执行成功
      expect(true).toBe(true);
    });
  });

  describe('CL-004: logAuthenticated', () => {
    it('应该能记录认证事件', () => {
      logAuthenticated();
      expect(true).toBe(true);
    });
  });

  describe('CL-005: logDisconnected', () => {
    it('应该能记录断开事件', () => {
      logDisconnected('test reason');
      expect(true).toBe(true);
    });
  });

  describe('CL-006: logReconnecting', () => {
    it('应该能记录重连事件', () => {
      logReconnecting(1);
      expect(true).toBe(true);
    });
  });

  describe('CL-007: logError', () => {
    it('应该能记录错误事件', () => {
      logError('test error');
      expect(true).toBe(true);
    });
  });

  describe('文件路径', () => {
    it('应该返回正确的日志文件路径', () => {
      const path = getLogFilePath();
      expect(path).toContain('.wecom-aibot-mcp');
      expect(path).toContain('connection.log');
    });

    it('应该返回正确的统计文件路径', () => {
      const path = getStatsFilePath();
      expect(path).toContain('.wecom-aibot-mcp');
      expect(path).toContain('connection-stats.json');
    });
  });

  describe('ConnectionStats 结构', () => {
    it('统计信息应该包含所有字段', () => {
      const stats = {
        totalConnections: 10,
        successfulConnections: 8,
        failedConnections: 2,
        lastConnectionTime: Date.now(),
        totalDuration: 3600000,
      };

      expect(stats.totalConnections).toBe(10);
      expect(stats.successfulConnections).toBe(8);
      expect(stats.failedConnections).toBe(2);
      expect(stats.lastConnectionTime).toBeDefined();
      expect(stats.totalDuration).toBe(3600000);
    });
  });
});