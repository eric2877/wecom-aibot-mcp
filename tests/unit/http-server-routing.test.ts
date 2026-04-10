/**
 * HTTP Server 单元测试 - CC Registry 逻辑
 *
 * 测试覆盖：
 * - HS-202: CC Registry 管理
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

describe('HTTP Server - CC Registry 逻辑', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // 清理所有已注册的 CCID
    const onlineCcIds = getOnlineCcIds();
    for (const ccId of onlineCcIds) {
      unregisterCcId(ccId);
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('HS-202: CC Registry 管理', () => {
    it('应该能注册 CCID', () => {
      const ccId = 'test-project-1';
      registerCcId(ccId, 'robot-1', 'agent-1');

      expect(getCCRegistryEntry(ccId)).not.toBeNull();
      expect(getRobotByCcId(ccId)).toBe('robot-1');
    });

    it('应该能注销 CCID', () => {
      const ccId = 'test-project-2';
      registerCcId(ccId, 'robot-1', 'agent-1');

      expect(getCCRegistryEntry(ccId)).not.toBeNull();

      unregisterCcId(ccId);

      expect(getCCRegistryEntry(ccId)).toBeNull();
      expect(getRobotByCcId(ccId)).toBeNull();
    });

    it('应该能获取 CC Registry Entry', () => {
      const ccId = 'test-project-3';
      registerCcId(ccId, 'robot-1', 'agent-1');

      const entry = getCCRegistryEntry(ccId);
      expect(entry).not.toBeNull();
      expect(entry?.robotName).toBe('robot-1');
      expect(entry?.agentName).toBe('agent-1');
    });

    it('获取不存在的 CCID 应该返回 null', () => {
      expect(getRobotByCcId('nonexistent')).toBeNull();
      expect(getCCRegistryEntry('nonexistent')).toBeNull();
    });
  });

  describe('HS-203: 多 CC 统计', () => {
    it('应该能获取 CC 总数', () => {
      const initialCount = getCCCount();

      const ccId1 = 'test-project-4';
      const ccId2 = 'test-project-5';
      registerCcId(ccId1, 'robot-1');
      registerCcId(ccId2, 'robot-2');

      expect(getCCCount()).toBe(initialCount + 2);

      unregisterCcId(ccId1);
      unregisterCcId(ccId2);
    });

    it('应该能按机器人统计 CC 数量', () => {
      const ccId1 = 'test-project-6';
      const ccId2 = 'test-project-7';
      const ccId3 = 'test-project-8';
      registerCcId(ccId1, 'robot-1');
      registerCcId(ccId2, 'robot-1');
      registerCcId(ccId3, 'robot-2');

      expect(getCCCountByRobot('robot-1')).toBe(2);
      expect(getCCCountByRobot('robot-2')).toBe(1);

      unregisterCcId(ccId1);
      unregisterCcId(ccId2);
      unregisterCcId(ccId3);
    });

    it('应该能获取在线 CCID 列表', () => {
      const ccId1 = 'test-project-9';
      const ccId2 = 'test-project-10';
      registerCcId(ccId1, 'robot-1');
      registerCcId(ccId2, 'robot-2');

      const onlineCcIds = getOnlineCcIds();
      expect(onlineCcIds).toContain(ccId1);
      expect(onlineCcIds).toContain(ccId2);

      unregisterCcId(ccId1);
      unregisterCcId(ccId2);
    });
  });

  describe('HS-204: 常量验证', () => {
    it('HTTP_PORT 应该是固定端口 18963', () => {
      expect(HTTP_PORT).toBe(18963);
    });

    it('HOOK_SCRIPT_PATH 应该包含正确路径', () => {
      expect(HOOK_SCRIPT_PATH).toContain('.wecom-aibot-mcp');
      expect(HOOK_SCRIPT_PATH).toContain('permission-hook.sh');
    });
  });

  describe('HS-205: 引用匹配正则表达式', () => {
    it('应该匹配任意 ccId 格式（项目名）', () => {
      const regex = /【([^】]+)】/;
      expect('【my-app】消息'.match(regex)?.[1]).toBe('my-app');
      expect('【ModuleStudio】消息'.match(regex)?.[1]).toBe('ModuleStudio');
      expect('【wecom-aibot-mcp】消息'.match(regex)?.[1]).toBe('wecom-aibot-mcp');
    });

    it('不应该匹配无括号格式', () => {
      const regex = /【([^】]+)】/;
      expect('my-app 无括号'.match(regex)).toBeNull();
      expect('[my-app] 英文括号'.match(regex)).toBeNull();
    });

    it('应该正确处理嵌入在长文本中的 ccId', () => {
      const regex = /【([^】]+)】/;
      const longText = '用户回复了一条消息，引用了【my-project】之前的消息内容';
      expect(longText.match(regex)?.[1]).toBe('my-project');
    });

    it('应该只匹配第一个 ccId', () => {
      const regex = /【([^】]+)】/;
      const multiText = '【project1】第一【project2】第二';
      expect(multiText.match(regex)?.[1]).toBe('project1');
    });
  });

  describe('HS-206: CCID 在 Registry 中的使用', () => {
    it('注册的 CCID 应该能用于路由匹配', () => {
      const ccId = 'test-project-11';
      registerCcId(ccId, 'robot-1');

      const robotName = getRobotByCcId(ccId);
      expect(robotName).toBe('robot-1');

      // 验证可以通过引用匹配
      const quoteText = `【${ccId}】消息内容`;
      const match = quoteText.match(/【([^】]+)】/);
      expect(match?.[1]).toBe(ccId);

      unregisterCcId(ccId);
    });
  });
});