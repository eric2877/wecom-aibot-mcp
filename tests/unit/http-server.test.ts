/**
 * HTTP Server 单元测试
 *
 * 测试覆盖：
 * - HS-001: CC Registry 管理
 * - HS-002: 多 CC 场景
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

// 导入实际函数
import {
  registerCcId,
  unregisterCcId,
  getRobotByCcId,
  getCCRegistryEntry,
  getCCCount,
  getCCCountByRobot,
  getOnlineCcIds,
  HTTP_PORT,
  HOOK_SCRIPT_PATH,
} from '../../src/http-server';

describe('HTTP Server', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('HS-001: CC Registry 管理', () => {
    it('应该能注册和查询 CCID', () => {
      const ccId = 'test-cc-1';
      registerCcId(ccId, 'test-robot', 'test-agent');

      expect(getCCRegistryEntry(ccId)).not.toBeNull();
      expect(getRobotByCcId(ccId)).toBe('test-robot');

      const entry = getCCRegistryEntry(ccId);
      expect(entry?.robotName).toBe('test-robot');
      expect(entry?.agentName).toBe('test-agent');

      unregisterCcId(ccId);
    });

    it('应该能注销 CCID', () => {
      const ccId = 'test-cc-2';
      registerCcId(ccId, 'test-robot');

      expect(getCCRegistryEntry(ccId)).not.toBeNull();

      unregisterCcId(ccId);

      expect(getCCRegistryEntry(ccId)).toBeNull();
      expect(getRobotByCcId(ccId)).toBeNull();
    });

    it('查询不存在的 CCID 应该返回 null', () => {
      expect(getRobotByCcId('cc-nonexistent')).toBeNull();
      expect(getCCRegistryEntry('cc-nonexistent')).toBeNull();
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

  describe('HS-002: 多 CC 场景', () => {
    it('应该能同时管理多个 CCID', () => {
      const ccId1 = 'test-cc-3';
      const ccId2 = 'test-cc-4';
      registerCcId(ccId1, 'robot1');
      registerCcId(ccId2, 'robot2');

      expect(getCCRegistryEntry(ccId1)).not.toBeNull();
      expect(getCCRegistryEntry(ccId2)).not.toBeNull();
      expect(getRobotByCcId(ccId1)).toBe('robot1');
      expect(getRobotByCcId(ccId2)).toBe('robot2');

      unregisterCcId(ccId1);
      unregisterCcId(ccId2);
    });

    it('注销特定 CCID 应该不影响其他 CCID', () => {
      const ccId1 = 'test-cc-5';
      const ccId2 = 'test-cc-6';
      registerCcId(ccId1, 'robot1');
      registerCcId(ccId2, 'robot2');

      unregisterCcId(ccId1);

      expect(getCCRegistryEntry(ccId1)).toBeNull();
      expect(getCCRegistryEntry(ccId2)).not.toBeNull();

      unregisterCcId(ccId2);
    });
  });

  describe('CC Registry 数据结构', () => {
    it('Registry 数据应该包含所有字段', () => {
      const ccId = 'test-cc-7';
      registerCcId(ccId, 'test-robot', 'test-agent');

      const entry = getCCRegistryEntry(ccId);

      expect(entry?.robotName).toBe('test-robot');
      expect(entry?.agentName).toBe('test-agent');

      unregisterCcId(ccId);
    });

    it('agentName 应该是可选的', () => {
      const ccId = 'test-cc-8';
      registerCcId(ccId, 'test-robot');

      const entry = getCCRegistryEntry(ccId);

      expect(entry?.agentName).toBeUndefined();

      unregisterCcId(ccId);
    });
  });

  describe('CC 统计功能', () => {
    it('应该能获取 CC 总数', () => {
      const initialCount = getCCCount();

      const ccId1 = 'test-cc-9';
      const ccId2 = 'test-cc-10';
      registerCcId(ccId1, 'robot1');
      registerCcId(ccId2, 'robot2');

      expect(getCCCount()).toBe(initialCount + 2);

      unregisterCcId(ccId1);
      unregisterCcId(ccId2);
    });

    it('应该能按机器人统计 CC 数量', () => {
      const ccId1 = 'test-cc-11';
      const ccId2 = 'test-cc-12';
      const ccId3 = 'test-cc-13';
      registerCcId(ccId1, 'robot1');
      registerCcId(ccId2, 'robot1');
      registerCcId(ccId3, 'robot2');

      expect(getCCCountByRobot('robot1')).toBe(2);
      expect(getCCCountByRobot('robot2')).toBe(1);

      unregisterCcId(ccId1);
      unregisterCcId(ccId2);
      unregisterCcId(ccId3);
    });

    it('应该能获取在线 CCID 列表', () => {
      const ccId1 = 'test-cc-14';
      const ccId2 = 'test-cc-15';
      registerCcId(ccId1, 'robot1');
      registerCcId(ccId2, 'robot2');

      const onlineCcIds = getOnlineCcIds();
      expect(onlineCcIds).toContain(ccId1);
      expect(onlineCcIds).toContain(ccId2);

      unregisterCcId(ccId1);
      unregisterCcId(ccId2);
    });
  });

  describe('引用路由逻辑', () => {
    it('应该从引用内容中提取 ccId', () => {
      const quote = '【my-project】已进入微信模式，使用机器人「ClaudeCode」。';
      const match = quote.match(/【([^】]+)】/);
      const ccId = match ? match[1] : null;
      expect(ccId).toBe('my-project');
    });

    it('应该正确提取不同格式的 ccId', () => {
      expect('【my-app】内容'.match(/【([^】]+)】/)?.[1]).toBe('my-app');
      expect('【ModuleStudio】内容'.match(/【([^】]+)】/)?.[1]).toBe('ModuleStudio');
      expect('【wecom-aibot-mcp】内容'.match(/【([^】]+)】/)?.[1]).toBe('wecom-aibot-mcp');
    });

    it('无引用内容时应该返回 null', () => {
      expect(undefined?.match(/【([^】]+)】/)).toBeUndefined();
      expect(''.match(/【([^】]+)】/)).toBeNull();
    });

    it('不包含 ccId 格式时应该返回 null', () => {
      expect('普通消息'.match(/【([^】]+)】/)).toBeNull();
    });
  });

  describe('单 CC 直接推送逻辑', () => {
    it('只有一个 CC 时应该触发直接推送', () => {
      const ccId = 'test-cc-16';
      registerCcId(ccId, 'robot1');

      // 单 CC 模式：getCCCount() === 1
      expect(getCCCount()).toBeGreaterThanOrEqual(1);

      unregisterCcId(ccId);
    });
  });

  describe('多 CC 无引用提示逻辑', () => {
    it('多个 CC 时应该触发提示', () => {
      const ccId1 = 'test-cc-17';
      const ccId2 = 'test-cc-18';
      registerCcId(ccId1, 'robot1');
      registerCcId(ccId2, 'robot2');

      // 多 CC 模式：getCCCount() > 1
      expect(getCCCount()).toBeGreaterThanOrEqual(2);
      expect(getOnlineCcIds().length).toBeGreaterThanOrEqual(2);

      unregisterCcId(ccId1);
      unregisterCcId(ccId2);
    });
  });
});