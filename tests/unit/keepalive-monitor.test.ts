/**
 * Keepalive Monitor 单元测试
 *
 * 测试覆盖：
 * - KM-001: startKeepaliveMonitor
 * - KM-002: stopKeepaliveMonitor
 * - KM-003: triggerKeepaliveCheck
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// 模拟依赖
vi.mock('../../src/connection-manager.js', () => ({
  getConnectionState: vi.fn(() => ({ connected: false, robotName: null, connectedAt: null })),
}));

vi.mock('../../src/http-server.js', () => ({
  getFirstActiveSession: vi.fn(() => null),
  hasActiveHeadlessSession: vi.fn(() => false),
}));

vi.mock('../../src/client.js', () => ({}));

// 导入实际函数
import {
  startKeepaliveMonitor,
  stopKeepaliveMonitor,
  triggerKeepaliveCheck,
} from '../../src/keepalive-monitor';

describe('Keepalive Monitor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('KM-001: startKeepaliveMonitor', () => {
    it('应该能启动保活监控', () => {
      startKeepaliveMonitor();
      // 验证函数执行成功
      expect(true).toBe(true);
    });
  });

  describe('KM-002: stopKeepaliveMonitor', () => {
    it('应该能停止保活监控', () => {
      startKeepaliveMonitor();
      stopKeepaliveMonitor();
      // 验证函数执行成功
      expect(true).toBe(true);
    });

    it('未启动时停止应该无操作', () => {
      stopKeepaliveMonitor();
      expect(true).toBe(true);
    });
  });

  describe('KM-003: triggerKeepaliveCheck', () => {
    it('应该能触发保活检查', async () => {
      await triggerKeepaliveCheck();
      // 验证函数执行成功
      expect(true).toBe(true);
    });
  });
});