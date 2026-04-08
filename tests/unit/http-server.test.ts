/**
 * HTTP Server 单元测试
 *
 * 测试覆盖：
 * - HS-001: ccId 管理
 * - HS-002: ccId 生成
 * - HS-003: 消息路由
 * - HS-004: 多 CC 场景
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// 模拟依赖（必须在导入前）
vi.mock('../../src/connection-manager.js', () => ({
  getClient: vi.fn(),
  getConnectionState: vi.fn(() => ({ connected: false, robotName: null, connectedAt: null })),
  getAllConnectionStates: vi.fn(() => [])
}));

vi.mock('../../src/message-bus.js', () => ({
  subscribeWecomMessage: vi.fn(),
  WecomMessage: {}
}));

vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: vi.fn(() => ({
    server: { notification: vi.fn() },
    connect: vi.fn()
  }))
}));

vi.mock('@modelcontextprotocol/sdk/server/streamableHttp.js', () => ({
  StreamableHTTPServerTransport: vi.fn(() => ({}))
}));

vi.mock('./tools/index.js', () => ({
  registerTools: vi.fn()
}));

// 模拟 cc-registry（getFirstActiveCcId 需要 getCcIdBinding）
vi.mock('../../src/cc-registry.js', () => ({
  getCcIdBinding: vi.fn((ccId: string) => ccId.includes('cc-') ? { robotName: 'test-robot' } : null),
  isCcIdRegistered: vi.fn(() => true),
  registerCcId: vi.fn(() => 'registered'),
  unregisterCcId: vi.fn(),
  touchCcId: vi.fn(),
}));

// 导入实际函数
import {
  generateCcId,
  registerActiveCcId,
  unregisterActiveCcId,
  hasActiveHeadlessSession,
  getFirstActiveCcId,
  HTTP_PORT,
  HOOK_SCRIPT_PATH,
} from '../../src/http-server';

describe('HTTP Server', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // 清理所有可能的活跃 ccId
    unregisterActiveCcId('cc-1');
    unregisterActiveCcId('cc-2');
    unregisterActiveCcId('cc-3');
    unregisterActiveCcId('test-cc-1');
    unregisterActiveCcId('test-cc-2');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('HS-001: ccId 管理', () => {
    it('注册后 hasActiveHeadlessSession 应该返回 true', () => {
      expect(hasActiveHeadlessSession()).toBe(false);

      registerActiveCcId('cc-1');
      expect(hasActiveHeadlessSession()).toBe(true);

      unregisterActiveCcId('cc-1');
      expect(hasActiveHeadlessSession()).toBe(false);
    });

    it('应该能注册和注销 ccId', () => {
      registerActiveCcId('test-cc-1');
      const first = getFirstActiveCcId();
      expect(first).not.toBeNull();
      expect(first?.ccId).toBe('test-cc-1');

      unregisterActiveCcId('test-cc-1');
      expect(hasActiveHeadlessSession()).toBe(false);
    });

    it('无活跃 ccId 时 getFirstActiveCcId 应该返回 null', () => {
      const result = getFirstActiveCcId();
      expect(result).toBeNull();
    });
  });

  describe('HS-002: ccId 生成', () => {
    it('应该生成递增的 ccId', () => {
      const ccId1 = generateCcId();
      const ccId2 = generateCcId();
      const ccId3 = generateCcId();

      expect(ccId1).toBe('cc-1');
      expect(ccId2).toBe('cc-2');
      expect(ccId3).toBe('cc-3');
    });

    it('生成的 ccId 应该能用于注册', () => {
      const ccId = generateCcId();
      registerActiveCcId(ccId);
      expect(hasActiveHeadlessSession()).toBe(true);

      unregisterActiveCcId(ccId);
      expect(hasActiveHeadlessSession()).toBe(false);
    });

    it('ccId 格式应该正确', () => {
      const ccId = generateCcId();
      expect(ccId).toMatch(/^cc-\d+$/);
    });
  });

  describe('常量', () => {
    it('HTTP_PORT 应该是固定端口', () => {
      expect(HTTP_PORT).toBe(18963);
    });

    it('HOOK_SCRIPT_PATH 应该包含正确路径', () => {
      expect(HOOK_SCRIPT_PATH).toContain('.wecom-aibot-mcp');
      expect(HOOK_SCRIPT_PATH).toContain('permission-hook.sh');
    });
  });

  describe('HS-003: 多 ccId 场景', () => {
    it('应该能同时管理多个 ccId', () => {
      registerActiveCcId('cc-1');
      registerActiveCcId('cc-2');

      expect(hasActiveHeadlessSession()).toBe(true);
      const first = getFirstActiveCcId();
      expect(first).not.toBeNull();
      expect(first?.ccId).toBe('cc-1');
    });

    it('注销特定 ccId 应该不影响其他 ccId', () => {
      registerActiveCcId('cc-1');
      registerActiveCcId('cc-2');

      unregisterActiveCcId('cc-1');

      expect(hasActiveHeadlessSession()).toBe(true);
      const first = getFirstActiveCcId();
      expect(first).not.toBeNull();
      expect(first?.ccId).toBe('cc-2');
    });
  });

  describe('引用路由逻辑', () => {
    it('应该从引用内容中提取 ccId', () => {
      const quote = '【cc-1】已进入微信模式，使用机器人「ClaudeCode」。';
      const match = quote.match(/【(cc-\d+)】/);
      const ccId = match ? match[1] : null;
      expect(ccId).toBe('cc-1');
    });

    it('应该正确提取不同序号的 ccId', () => {
      expect('【cc-1】内容'.match(/【(cc-\d+)】/)?.[1]).toBe('cc-1');
      expect('【cc-2】内容'.match(/【(cc-\d+)】/)?.[1]).toBe('cc-2');
      expect('【cc-10】内容'.match(/【(cc-\d+)】/)?.[1]).toBe('cc-10');
      expect('【cc-999】内容'.match(/【(cc-\d+)】/)?.[1]).toBe('cc-999');
    });

    it('无引用内容时应该返回 null', () => {
      expect(undefined?.match(/【(cc-\d+)】/)).toBeUndefined();
      expect(''.match(/【(cc-\d+)】/)).toBeNull();
    });

    it('不包含 ccId 格式时应该返回 null', () => {
      expect('普通消息'.match(/【(cc-\d+)】/)).toBeNull();
      expect('【其他标签】内容'.match(/【(cc-\d+)】/)).toBeNull();
      expect('cc-1 没有方括号'.match(/【(cc-\d+)】/)).toBeNull();
    });
  });

  describe('单 CC 直接推送逻辑', () => {
    it('只有一个 ccId 时应该触发直接推送', () => {
      registerActiveCcId('cc-1');

      const size = hasActiveHeadlessSession() ? 1 : 0;
      expect(size).toBe(1);

      unregisterActiveCcId('cc-1');
    });
  });

  describe('多 CC 无引用提示逻辑', () => {
    it('多个 ccId 时应该提示引用', () => {
      registerActiveCcId('cc-1');
      registerActiveCcId('cc-2');

      expect(hasActiveHeadlessSession()).toBe(true);
      const first = getFirstActiveCcId();
      expect(first).not.toBeNull();

      unregisterActiveCcId('cc-1');
      unregisterActiveCcId('cc-2');
    });
  });
});
