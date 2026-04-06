/**
 * HTTP Server 单元测试 - 消息路由逻辑
 *
 * 测试覆盖：
 * - HS-201: 引用内容解析
 * - HS-202: Session 路由匹配
 * - HS-203: 多 CC 路由逻辑
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// 模拟依赖（不启动 HTTP 服务器）
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
  McpServer: vi.fn()
}));

vi.mock('@modelcontextprotocol/sdk/server/streamableHttp.js', () => ({
  StreamableHTTPServerTransport: vi.fn()
}));

vi.mock('../../src/tools/index.js', () => ({
  registerTools: vi.fn()
}));

// 导入实际函数
import {
  generateCcId,
  setSessionData,
  getSessionData,
  deleteSession,
  hasActiveHeadlessSession,
  getFirstActiveSession,
  findSessionByRobotName,
  HTTP_PORT,
  HOOK_SCRIPT_PATH,
} from '../../src/http-server';

describe('HTTP Server - 消息路由逻辑', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // 清理 sessions
    ['s1', 's2', 's3', 's4', 's5'].forEach(id => deleteSession(id));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('HS-201: 引用内容解析', () => {
    it('应该从引用内容中正确提取 ccId', () => {
      const cases = [
        { quote: '【cc-1】已进入微信模式', expected: 'cc-1' },
        { quote: '【cc-2】内容', expected: 'cc-2' },
        { quote: '【cc-10】消息', expected: 'cc-10' },
        { quote: '【cc-999】长文本', expected: 'cc-999' },
      ];

      for (const { quote, expected } of cases) {
        const match = quote.match(/【(cc-\d+)】/);
        const ccId = match ? match[1] : null;
        expect(ccId).toBe(expected);
      }
    });

    it('无效引用内容应该返回 null', () => {
      const invalidCases = [
        undefined,
        '',
        '普通消息',
        '【其他标签】内容',
        'cc-1 没有方括号',
        '【cc-abc】非数字',
      ];

      for (const quote of invalidCases) {
        const match = quote?.match(/【(cc-\d+)】/);
        const ccId = match ? match[1] : null;
        expect(ccId).toBeNull();
      }
    });
  });

  describe('HS-202: Session 路由匹配', () => {
    it('应该能根据 robotName 查找 Session', () => {
      setSessionData('s1', { robotName: 'robot-A', ccId: 'cc-1', createdAt: Date.now() });
      setSessionData('s2', { robotName: 'robot-B', ccId: 'cc-2', createdAt: Date.now() });
      setSessionData('s3', { robotName: 'robot-C', ccId: 'cc-3', createdAt: Date.now() });

      expect(findSessionByRobotName('robot-A')).toBe('s1');
      expect(findSessionByRobotName('robot-B')).toBe('s2');
      expect(findSessionByRobotName('robot-C')).toBe('s3');
      expect(findSessionByRobotName('robot-D')).toBeNull();
    });

    it('修改 Session 后应该能正确查找', () => {
      setSessionData('s1', { robotName: 'robot-A', ccId: 'cc-1', createdAt: Date.now() });

      expect(findSessionByRobotName('robot-A')).toBe('s1');

      // 修改 Session
      deleteSession('s1');
      setSessionData('s2', { robotName: 'robot-A', ccId: 'cc-2', createdAt: Date.now() });

      expect(findSessionByRobotName('robot-A')).toBe('s2');
      expect(getSessionData('s1')).toBeNull();
    });

    it('多个相同 robotName 的 Session 应该返回第一个', () => {
      setSessionData('s1', { robotName: 'robot-A', ccId: 'cc-1', createdAt: Date.now() });
      setSessionData('s2', { robotName: 'robot-A', ccId: 'cc-2', createdAt: Date.now() });

      const result = findSessionByRobotName('robot-A');
      expect(result).toBe('s1'); // Map 返回第一个匹配的
    });
  });

  describe('HS-203: 多 CC 路由逻辑', () => {
    it('单 CC 模式应该直接推送', () => {
      setSessionData('s1', { robotName: 'robot-A', ccId: 'cc-1', createdAt: Date.now() });

      expect(hasActiveHeadlessSession()).toBe(true);
      const session = getFirstActiveSession();
      expect(session).not.toBeNull();
      expect(session?.data.ccId).toBe('cc-1');
    });

    it('多 CC 模式应该需要引用路由', () => {
      setSessionData('s1', { robotName: 'robot-A', ccId: 'cc-1', createdAt: Date.now() });
      setSessionData('s2', { robotName: 'robot-B', ccId: 'cc-2', createdAt: Date.now() });

      expect(hasActiveHeadlessSession()).toBe(true);
      // 多 CC 时 getFirstActiveSession 返回第一个
      const firstSession = getFirstActiveSession();
      expect(firstSession).not.toBeNull();

      // 检查两个 Session 都存在
      expect(getSessionData('s1')).not.toBeNull();
      expect(getSessionData('s2')).not.toBeNull();
    });

    it('无 CC 模式应该返回无活跃 Session', () => {
      expect(hasActiveHeadlessSession()).toBe(false);
      expect(getFirstActiveSession()).toBeNull();
    });
  });

  describe('HS-204: ccId 序号递增', () => {
    it('多次调用 generateCcId 应该递增', () => {
      // 由于序号是全局的，需要清理
      const id1 = generateCcId();
      const id2 = generateCcId();
      const id3 = generateCcId();

      expect(id1).toMatch(/^cc-\d+$/);
      expect(id2).toMatch(/^cc-\d+$/);
      expect(id3).toMatch(/^cc-\d+$/);

      // 提取数字部分验证递增
      const num1 = parseInt(id1.replace('cc-', ''), 10);
      const num2 = parseInt(id2.replace('cc-', ''), 10);
      const num3 = parseInt(id3.replace('cc-', ''), 10);

      expect(num2).toBe(num1 + 1);
      expect(num3).toBe(num2 + 1);
    });
  });

  describe('HS-205: Session 生命周期', () => {
    it('Session 创建后应该能正确查询', () => {
      const createdAt = Date.now();
      setSessionData('s1', { robotName: 'robot', ccId: 'cc-1', createdAt });

      const data = getSessionData('s1');
      expect(data?.robotName).toBe('robot');
      expect(data?.ccId).toBe('cc-1');
      expect(data?.createdAt).toBe(createdAt);
    });

    it('Session 删除后应该不存在', () => {
      setSessionData('s1', { robotName: 'robot', ccId: 'cc-1', createdAt: Date.now() });
      expect(getSessionData('s1')).not.toBeNull();

      deleteSession('s1');
      expect(getSessionData('s1')).toBeNull();
      expect(hasActiveHeadlessSession()).toBe(false);
    });

    it('删除不存在的 Session 应该不报错', () => {
      deleteSession('non-existent');
      expect(getSessionData('non-existent')).toBeNull();
    });

    it('获取不存在的 Session 应该返回 null', () => {
      expect(getSessionData('non-existent')).toBeNull();
    });
  });

  describe('HS-206: Session 数据完整性', () => {
    it('Session 数据应该包含所有必要字段', () => {
      const data = {
        robotName: 'test-robot',
        agentName: 'test-agent',
        ccId: 'cc-1',
        createdAt: Date.now(),
      };

      setSessionData('s1', data);

      const result = getSessionData('s1');
      expect(result?.robotName).toBe('test-robot');
      expect(result?.agentName).toBe('test-agent');
      expect(result?.ccId).toBe('cc-1');
      expect(result?.createdAt).toBe(data.createdAt);
    });

    it('agentName 应该可选', () => {
      setSessionData('s1', {
        robotName: 'test-robot',
        ccId: 'cc-1',
        createdAt: Date.now(),
      });

      const result = getSessionData('s1');
      expect(result?.agentName).toBeUndefined();
    });
  });

  describe('HS-207: 常量验证', () => {
    it('HTTP_PORT 应该是固定端口 18963', () => {
      expect(HTTP_PORT).toBe(18963);
    });

    it('HOOK_SCRIPT_PATH 应该包含正确路径', () => {
      expect(HOOK_SCRIPT_PATH).toContain('.wecom-aibot-mcp');
      expect(HOOK_SCRIPT_PATH).toContain('permission-hook.sh');
    });
  });

  describe('HS-208: 边界条件', () => {
    it('getSessionDataById 应该处理 undefined', () => {
      // 直接测试函数行为
      const result = getSessionData('non-existent');
      expect(result).toBeNull();
    });

    it('空 Session Store 时 hasActiveHeadlessSession 应该返回 false', () => {
      ['s1', 's2', 's3'].forEach(id => deleteSession(id));
      expect(hasActiveHeadlessSession()).toBe(false);
    });

    it('空 Session Store 时 getFirstActiveSession 应该返回 null', () => {
      ['s1', 's2', 's3'].forEach(id => deleteSession(id));
      expect(getFirstActiveSession()).toBeNull();
    });
  });

  describe('HS-209: 引用匹配正则表达式', () => {
    it('应该匹配标准 ccId 格式', () => {
      const regex = /【(cc-\d+)】/;
      expect('【cc-1】消息'.match(regex)?.[1]).toBe('cc-1');
      expect('【cc-12】消息'.match(regex)?.[1]).toBe('cc-12');
      expect('【cc-123】消息'.match(regex)?.[1]).toBe('cc-123');
    });

    it('不应该匹配非标准格式', () => {
      const regex = /【(cc-\d+)】/;
      expect('【CC-1】大写'.match(regex)).toBeNull();
      expect('【cc-x】非数字'.match(regex)).toBeNull();
      expect('cc-1 无括号'.match(regex)).toBeNull();
      expect('[cc-1] 英文括号'.match(regex)).toBeNull();
    });

    it('应该正确处理嵌入在长文本中的 ccId', () => {
      const regex = /【(cc-\d+)】/;
      const longText = '用户回复了一条消息，引用了【cc-5】之前的消息内容';
      expect(longText.match(regex)?.[1]).toBe('cc-5');
    });

    it('应该只匹配第一个 ccId', () => {
      const regex = /【(cc-\d+)】/;
      const multiText = '【cc-1】第一【cc-2】第二';
      expect(multiText.match(regex)?.[1]).toBe('cc-1');
    });
  });

  describe('HS-210: ccId 在 Session 中的使用', () => {
    it('Session ccId 应该能用于路由匹配', () => {
      setSessionData('s1', { robotName: 'robot', ccId: 'cc-10', createdAt: Date.now() });

      const data = getSessionData('s1');
      const ccId = data?.ccId;

      // 验证 ccId 格式
      expect(ccId).toMatch(/^cc-\d+$/);

      // 验证可以通过引用匹配
      const quoteText = `【${ccId}】消息内容`;
      const match = quoteText.match(/【(cc-\d+)】/);
      expect(match?.[1]).toBe(ccId);
    });
  });
});