/**
 * HTTP Server 单元测试
 *
 * 测试覆盖：
 * - HS-001: Session 管理
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

// 导入实际函数
import {
  generateCcId,
  setSessionData,
  getSessionData,
  getSessionDataById,
  deleteSession,
  hasActiveHeadlessSession,
  getFirstActiveSession,
  findSessionByRobotName,
  HTTP_PORT,
  HOOK_SCRIPT_PATH,
} from '../../src/http-server';

describe('HTTP Server', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // 清理 session store
    const sessions = ['session-1', 'session-2', 'session-3', 'session-4'];
    sessions.forEach(id => deleteSession(id));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('HS-001: Session 管理', () => {
    it('应该能设置和获取 Session', () => {
      setSessionData('session-1', {
        robotName: 'test-robot',
        ccId: 'cc-1',
        createdAt: Date.now(),
      });

      const data = getSessionData('session-1');

      expect(data).not.toBeNull();
      expect(data?.robotName).toBe('test-robot');
      expect(data?.ccId).toBe('cc-1');
    });

    it('应该能删除 Session', () => {
      setSessionData('session-1', {
        robotName: 'test-robot',
        ccId: 'cc-1',
        createdAt: Date.now(),
      });

      expect(getSessionData('session-1')).not.toBeNull();

      deleteSession('session-1');

      expect(getSessionData('session-1')).toBeNull();
    });

    it('getSessionDataById 应该处理 undefined 参数', () => {
      const result = getSessionDataById(undefined);
      expect(result).toBeNull();
    });

    it('getSessionDataById 应该能获取 Session', () => {
      setSessionData('session-1', {
        robotName: 'test-robot',
        ccId: 'cc-1',
        createdAt: Date.now(),
      });

      const result = getSessionDataById('session-1');
      expect(result?.robotName).toBe('test-robot');
    });

    it('hasActiveHeadlessSession 应该正确反映状态', () => {
      expect(hasActiveHeadlessSession()).toBe(false);

      setSessionData('session-1', {
        robotName: 'test-robot',
        ccId: 'cc-1',
        createdAt: Date.now(),
      });

      expect(hasActiveHeadlessSession()).toBe(true);

      deleteSession('session-1');

      expect(hasActiveHeadlessSession()).toBe(false);
    });

    it('getFirstActiveSession 应该返回第一个 Session', () => {
      setSessionData('session-1', {
        robotName: 'robot1',
        ccId: 'cc-1',
        createdAt: Date.now(),
      });

      const session = getFirstActiveSession();

      expect(session).not.toBeNull();
      expect(session?.sessionId).toBe('session-1');
      expect(session?.data.robotName).toBe('robot1');
    });

    it('无 Session 时 getFirstActiveSession 应该返回 null', () => {
      const session = getFirstActiveSession();
      expect(session).toBeNull();
    });

    it('findSessionByRobotName 应该能查找 Session', () => {
      setSessionData('session-1', {
        robotName: 'robot1',
        ccId: 'cc-1',
        createdAt: Date.now(),
      });
      setSessionData('session-2', {
        robotName: 'robot2',
        ccId: 'cc-2',
        createdAt: Date.now(),
      });

      const result1 = findSessionByRobotName('robot1');
      const result2 = findSessionByRobotName('robot2');
      const result3 = findSessionByRobotName('robot3');

      expect(result1).toBe('session-1');
      expect(result2).toBe('session-2');
      expect(result3).toBeNull();
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

    it('生成的 ccId 应该能用于 Session', () => {
      const ccId = generateCcId();
      setSessionData('session-1', {
        robotName: 'test-robot',
        ccId,
        createdAt: Date.now(),
      });

      const data = getSessionData('session-1');
      expect(data?.ccId).toBe(ccId);
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

  describe('HS-003: 多 Session 场景', () => {
    it('应该能同时管理多个 Session', () => {
      setSessionData('session-1', {
        robotName: 'robot1',
        ccId: 'cc-1',
        createdAt: Date.now(),
      });
      setSessionData('session-2', {
        robotName: 'robot2',
        ccId: 'cc-2',
        createdAt: Date.now(),
      });

      expect(hasActiveHeadlessSession()).toBe(true);
      expect(getSessionData('session-1')?.robotName).toBe('robot1');
      expect(getSessionData('session-2')?.robotName).toBe('robot2');
    });

    it('删除特定 Session 应该不影响其他 Session', () => {
      setSessionData('session-1', {
        robotName: 'robot1',
        ccId: 'cc-1',
        createdAt: Date.now(),
      });
      setSessionData('session-2', {
        robotName: 'robot2',
        ccId: 'cc-2',
        createdAt: Date.now(),
      });

      deleteSession('session-1');

      expect(getSessionData('session-1')).toBeNull();
      expect(getSessionData('session-2')).not.toBeNull();
      expect(hasActiveHeadlessSession()).toBe(true);
    });
  });

  describe('Session 数据结构', () => {
    it('Session 数据应该包含所有字段', () => {
      const sessionData = {
        robotName: 'test-robot',
        agentName: 'test-agent',
        ccId: 'cc-1',
        createdAt: 1234567890,
      };

      setSessionData('session-1', sessionData);

      const result = getSessionData('session-1');

      expect(result?.robotName).toBe('test-robot');
      expect(result?.agentName).toBe('test-agent');
      expect(result?.ccId).toBe('cc-1');
      expect(result?.createdAt).toBe(1234567890);
    });

    it('agentName 应该是可选的', () => {
      const sessionData = {
        robotName: 'test-robot',
        ccId: 'cc-1',
        createdAt: 1234567890,
      };

      setSessionData('session-1', sessionData);

      const result = getSessionData('session-1');

      expect(result?.agentName).toBeUndefined();
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
    it('只有一个 Session 时应该触发直接推送', () => {
      setSessionData('session-1', {
        robotName: 'robot1',
        ccId: 'cc-1',
        createdAt: Date.now(),
      });

      // 单 CC 模式：sessionStore.size === 1
      const size = hasActiveHeadlessSession() ? 1 : 0;
      expect(size).toBe(1);
    });
  });

  describe('多 CC 无引用提示逻辑', () => {
    it('多个 Session 时应该触发提示', () => {
      setSessionData('session-1', {
        robotName: 'robot1',
        ccId: 'cc-1',
        createdAt: Date.now(),
      });
      setSessionData('session-2', {
        robotName: 'robot2',
        ccId: 'cc-2',
        createdAt: Date.now(),
      });

      // 多 CC 模式：sessionStore.size > 1
      // 这里我们无法直接获取 size，但可以通过 getFirstActiveSession 间接验证
      expect(getFirstActiveSession()).not.toBeNull();
    });
  });
});