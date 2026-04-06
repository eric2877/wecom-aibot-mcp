/**
 * Keepalive Monitor 单元测试 - 扩展覆盖
 *
 * 测试覆盖：
 * - KM-101: 保活检查 - 无连接
 * - KM-102: 保活检查 - 有连接无待审批
 * - KM-103: 保活检查 - 有待审批
 * - KM-104: 保活消息发送
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// 使用 vi.hoisted 解决 mock 初始化顺序
const mockGetConnectionState = vi.hoisted(() => vi.fn(() => ({ connected: false, robotName: null, connectedAt: null })));
const mockGetClient = vi.hoisted(() => vi.fn());

vi.mock('../../src/connection-manager.js', () => ({
  getConnectionState: mockGetConnectionState,
  getClient: mockGetClient,
}));

vi.mock('../../src/http-server.js', () => ({
  getFirstActiveSession: vi.fn(() => null),
  hasActiveHeadlessSession: vi.fn(() => false),
}));

// 导入实际函数
import {
  startKeepaliveMonitor,
  stopKeepaliveMonitor,
  triggerKeepaliveCheck,
} from '../../src/keepalive-monitor';

describe('Keepalive Monitor - 扩展覆盖', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    // 默认返回无连接状态
    mockGetConnectionState.mockReturnValue({ connected: false, robotName: null, connectedAt: null });
    mockGetClient.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    stopKeepaliveMonitor();
  });

  describe('KM-101: 保活检查 - 无连接', () => {
    it('无连接时应该跳过检查', async () => {
      mockGetConnectionState.mockReturnValue({ connected: false, robotName: null, connectedAt: null });

      await triggerKeepaliveCheck();

      expect(mockGetConnectionState).toHaveBeenCalled();
      expect(mockGetClient).not.toHaveBeenCalled();
    });
  });

  describe('KM-102: 保活检查 - 有连接无待审批', () => {
    it('有连接但无待审批时应该跳过', async () => {
      mockGetConnectionState.mockReturnValue({ connected: true, robotName: 'test-robot', connectedAt: Date.now() });
      mockGetClient.mockResolvedValue({
        isConnected: () => true,
        getPendingApprovalsRecords: () => [],
        sendText: vi.fn().mockResolvedValue(true),
      });

      await triggerKeepaliveCheck();

      expect(mockGetConnectionState).toHaveBeenCalled();
      expect(mockGetClient).toHaveBeenCalled();
    });
  });

  describe('KM-103: 保活检查 - 有待审批', () => {
    it('有待审批时应该发送提醒', async () => {
      const mockSendText = vi.fn().mockResolvedValue(true);
      const now = Date.now();
      const sixMinutesAgo = now - 6 * 60 * 1000; // 6 分钟前

      mockGetConnectionState.mockReturnValue({ connected: true, robotName: 'test-robot', connectedAt: Date.now() });
      mockGetClient.mockResolvedValue({
        isConnected: () => true,
        getPendingApprovalsRecords: () => [
          {
            taskId: 'test-approval-1',
            toolName: 'Bash',
            timestamp: sixMinutesAgo,
          },
        ],
        sendText: mockSendText,
      });

      await triggerKeepaliveCheck();

      expect(mockGetConnectionState).toHaveBeenCalled();
    });

    it('待审批不足 5 分钟不应该发送提醒', async () => {
      const mockSendText = vi.fn().mockResolvedValue(true);
      const now = Date.now();
      const twoMinutesAgo = now - 2 * 60 * 1000; // 2 分钟前

      mockGetConnectionState.mockReturnValue({ connected: true, robotName: 'test-robot', connectedAt: Date.now() });
      mockGetClient.mockResolvedValue({
        isConnected: () => true,
        getPendingApprovalsRecords: () => [
          {
            taskId: 'test-approval-2',
            toolName: 'Bash',
            timestamp: twoMinutesAgo,
          },
        ],
        sendText: mockSendText,
      });

      await triggerKeepaliveCheck();

      expect(mockSendText).not.toHaveBeenCalled();
    });
  });

  describe('KM-104: 定时器启动和停止', () => {
    it('启动后定时器应该运行', () => {
      startKeepaliveMonitor();

      // 快进 1 分钟
      vi.advanceTimersByTime(60000);

      expect(mockGetConnectionState).toHaveBeenCalled();
    });

    it('停止后定时器不应该运行', () => {
      startKeepaliveMonitor();
      stopKeepaliveMonitor();

      // 清除之前的调用
      mockGetConnectionState.mockClear();

      // 快进 1 分钟
      vi.advanceTimersByTime(60000);

      // 不应该被调用
      expect(mockGetConnectionState).not.toHaveBeenCalled();
    });
  });

  describe('KM-105: 客户端获取失败', () => {
    it('客户端获取失败时应该跳过', async () => {
      mockGetConnectionState.mockReturnValue({ connected: true, robotName: 'test-robot', connectedAt: Date.now() });
      mockGetClient.mockResolvedValue(null);

      await triggerKeepaliveCheck();

      expect(mockGetClient).toHaveBeenCalledWith('test-robot');
    });
  });
});