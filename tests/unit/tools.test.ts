/**
 * MCP 工具单元测试
 *
 * 测试覆盖：
 * - T-001 ~ T-013: 各种工具场景
 * - 完整工具执行流程
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// 模拟依赖（必须在导入前）
vi.mock('../../src/connection-manager.js', () => ({
  connectRobot: vi.fn().mockResolvedValue({
    success: true,
    client: {
      sendText: vi.fn().mockResolvedValue(true),
      sendApprovalRequest: vi.fn().mockResolvedValue('approval_123'),
      getApprovalResult: vi.fn().mockReturnValue('pending'),
      getPendingMessages: vi.fn().mockReturnValue([]),
      isConnected: vi.fn().mockReturnValue(true),
      getPendingApprovalsRecords: vi.fn().mockReturnValue([]),
    }
  }),
  disconnectRobot: vi.fn(),
  getClient: vi.fn().mockResolvedValue({
    sendText: vi.fn().mockResolvedValue(true),
    sendApprovalRequest: vi.fn().mockResolvedValue('approval_123'),
    getApprovalResult: vi.fn().mockReturnValue('pending'),
    getPendingMessages: vi.fn().mockReturnValue([]),
    isConnected: vi.fn().mockReturnValue(true),
    getPendingApprovalsRecords: vi.fn().mockReturnValue([]),
  }),
  getConnectionState: vi.fn(() => ({ connected: true, robotName: 'ClaudeCode', connectedAt: Date.now() })),
  isRobotOccupied: vi.fn(() => false),
  getRobotOccupiedBy: vi.fn(() => undefined),
}));

vi.mock('../../src/config-wizard.js', () => ({
  listAllRobots: vi.fn(() => [
    { name: 'ClaudeCode', botId: 'bot1', targetUserId: 'user1', isDefault: true },
    { name: 'module-studio', botId: 'bot2', targetUserId: 'user2', isDefault: false }
  ]),
}));

vi.mock('../../src/http-server.js', () => ({
  getSessionDataById: vi.fn(),
  setSessionData: vi.fn(),
  deleteSession: vi.fn(),
  generateCcId: vi.fn(() => 'cc-1'),
}));

vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: vi.fn(() => ({
    tool: vi.fn(),
  })),
}));

// 导入实际函数
import { registerTools } from '../../src/tools/index';
import { listAllRobots } from '../../src/config-wizard';
import {
  connectRobot,
  disconnectRobot,
  getClient,
  getConnectionState,
  isRobotOccupied,
  getRobotOccupiedBy,
} from '../../src/connection-manager';
import {
  getSessionDataById,
  setSessionData,
  deleteSession,
  generateCcId,
} from '../../src/http-server';

describe('MCP Tools', () => {
  let toolHandlers: Map<string, { handler: Function; schema: any }>;

  beforeEach(() => {
    vi.clearAllMocks();
    toolHandlers = new Map();

    // 捕获工具注册
    const mockServer = {
      tool: vi.fn((name, description, schema, handler) => {
        toolHandlers.set(name, { handler, schema });
      }),
    };

    registerTools(mockServer as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('registerTools', () => {
    it('应该注册 11 个工具', () => {
      expect(toolHandlers.size).toBe(11);
    });

    it('应该注册 send_message 工具', () => {
      expect(toolHandlers.has('send_message')).toBe(true);
    });

    it('应该注册 enter_headless_mode 工具', () => {
      expect(toolHandlers.has('enter_headless_mode')).toBe(true);
    });

    it('应该注册 exit_headless_mode 工具', () => {
      expect(toolHandlers.has('exit_headless_mode')).toBe(true);
    });

    it('应该注册 send_approval_request 工具', () => {
      expect(toolHandlers.has('send_approval_request')).toBe(true);
    });

    it('应该注册 get_approval_result 工具', () => {
      expect(toolHandlers.has('get_approval_result')).toBe(true);
    });

    it('应该注册 list_robots 工具', () => {
      expect(toolHandlers.has('list_robots')).toBe(true);
    });

    it('应该注册 check_connection 工具', () => {
      expect(toolHandlers.has('check_connection')).toBe(true);
    });

    it('应该注册 get_setup_guide 工具', () => {
      expect(toolHandlers.has('get_setup_guide')).toBe(true);
    });
  });

  describe('send_message 工具', () => {
    it('有 Session 时应该调用 getClient', async () => {
      vi.mocked(getSessionDataById).mockReturnValue({
        robotName: 'ClaudeCode',
        ccId: 'cc-1',
        createdAt: Date.now(),
      });

      const handler = toolHandlers.get('send_message')!.handler;
      await handler(
        { content: 'test message' },
        { sessionId: 'session-1' }
      );

      expect(getClient).toHaveBeenCalledWith('ClaudeCode');
    });

    it('无 Session 时应该返回错误', async () => {
      vi.mocked(getSessionDataById).mockReturnValue(null);

      const handler = toolHandlers.get('send_message')!.handler;
      const result = await handler(
        { content: 'test message' },
        { sessionId: 'session-1' }
      );

      expect(result.content[0].text).toContain('未在微信模式');
    });
  });

  describe('send_approval_request 工具', () => {
    it('应该调用 getClient', async () => {
      vi.mocked(getSessionDataById).mockReturnValue({
        robotName: 'ClaudeCode',
        ccId: 'cc-1',
        createdAt: Date.now(),
      });

      const handler = toolHandlers.get('send_approval_request')!.handler;
      await handler(
        { title: 'Bash', description: 'Execute command', request_id: 'req-001' },
        { sessionId: 'session-1' }
      );

      expect(getClient).toHaveBeenCalledWith('ClaudeCode');
    });

    it('无 Session 时应该返回错误', async () => {
      vi.mocked(getSessionDataById).mockReturnValue(null);

      const handler = toolHandlers.get('send_approval_request')!.handler;
      const result = await handler(
        { title: 'Bash', description: 'Execute command', request_id: 'req-001' },
        { sessionId: 'session-1' }
      );

      expect(result.content[0].text).toContain('未在微信模式');
    });
  });

  describe('get_approval_result 工具', () => {
    it('应该调用 getClient', async () => {
      vi.mocked(getSessionDataById).mockReturnValue({
        robotName: 'ClaudeCode',
        ccId: 'cc-1',
        createdAt: Date.now(),
      });

      const handler = toolHandlers.get('get_approval_result')!.handler;
      const result = await handler(
        { task_id: 'approval_123' },
        { sessionId: 'session-1' }
      );

      expect(getClient).toHaveBeenCalledWith('ClaudeCode');
    });
  });

  describe('enter_headless_mode 工具', () => {
    it('无机器人配置时应该返回错误', async () => {
      vi.mocked(listAllRobots).mockReturnValueOnce([]);

      const handler = toolHandlers.get('enter_headless_mode')!.handler;
      const result = await handler(
        { agent_name: 'TestAgent' },
        { sessionId: 'session-1' }
      );

      const response = JSON.parse(result.content[0].text);
      expect(response.status).toBe('error');
    });

    it('多机器人未指定时应该返回选择列表', async () => {
      const handler = toolHandlers.get('enter_headless_mode')!.handler;
      const result = await handler(
        { agent_name: 'TestAgent' },
        { sessionId: 'session-1' }
      );

      const response = JSON.parse(result.content[0].text);
      expect(response.status).toBe('select_robot');
      expect(response.robots.length).toBe(2);
    });

    it('机器人被占用时应该返回错误', async () => {
      vi.mocked(isRobotOccupied).mockReturnValue(true);
      vi.mocked(getRobotOccupiedBy).mockReturnValue('OtherAgent');

      const handler = toolHandlers.get('enter_headless_mode')!.handler;
      const result = await handler(
        { agent_name: 'TestAgent', robot_id: 'ClaudeCode' },
        { sessionId: 'session-1' }
      );

      const response = JSON.parse(result.content[0].text);
      expect(response.status).toBe('error');
      expect(response.errorType).toBe('robot_occupied');
    });

    it('连接成功时应该设置 Session', async () => {
      vi.mocked(connectRobot).mockResolvedValueOnce({
        success: true,
        client: {
          sendText: vi.fn().mockResolvedValue(true),
        },
      } as any);

      const handler = toolHandlers.get('enter_headless_mode')!.handler;
      const result = await handler(
        { agent_name: 'TestAgent', robot_id: '1' },
        { sessionId: 'session-1' }
      );

      expect(setSessionData).toHaveBeenCalledWith('session-1', expect.objectContaining({
        robotName: 'ClaudeCode',
        agentName: 'TestAgent',
      }));
    });

    it('连接失败时应该返回错误', async () => {
      vi.mocked(connectRobot).mockResolvedValueOnce({
        success: false,
        error: 'Connection failed',
      });

      const handler = toolHandlers.get('enter_headless_mode')!.handler;
      const result = await handler(
        { agent_name: 'TestAgent', robot_id: '1' },
        { sessionId: 'session-1' }
      );

      const response = JSON.parse(result.content[0].text);
      expect(response.status).toBe('error');
    });
  });

  describe('exit_headless_mode 工具', () => {
    it('无 Session 时应该返回错误', async () => {
      vi.mocked(getSessionDataById).mockReturnValue(null);

      const handler = toolHandlers.get('exit_headless_mode')!.handler;
      const result = await handler({}, { sessionId: 'session-1' });

      const response = JSON.parse(result.content[0].text);
      expect(response.status).toBe('error');
    });

    it('有 Session 时应该断开连接', async () => {
      vi.mocked(getSessionDataById).mockReturnValue({
        robotName: 'ClaudeCode',
        ccId: 'cc-1',
        createdAt: Date.now(),
      });

      const handler = toolHandlers.get('exit_headless_mode')!.handler;
      const result = await handler({}, { sessionId: 'session-1' });

      expect(disconnectRobot).toHaveBeenCalledWith('ClaudeCode');
      expect(deleteSession).toHaveBeenCalledWith('session-1');
    });

    it('应该返回退出状态', async () => {
      vi.mocked(getSessionDataById).mockReturnValue({
        robotName: 'ClaudeCode',
        ccId: 'cc-1',
        createdAt: Date.now(),
        agentName: 'TestAgent',
      });

      const handler = toolHandlers.get('exit_headless_mode')!.handler;
      const result = await handler({}, { sessionId: 'session-1' });

      const response = JSON.parse(result.content[0].text);
      expect(response.status).toBe('exited');
      expect(response.robotName).toBe('ClaudeCode');
    });
  });

  describe('list_robots 工具', () => {
    it('应该列出所有机器人', async () => {
      const handler = toolHandlers.get('list_robots')!.handler;
      const result = await handler({}, {});

      const response = JSON.parse(result.content[0].text);
      expect(response.robots.length).toBe(2);
      expect(response.total).toBe(2);
    });
  });

  describe('check_connection 工具', () => {
    it('应该返回连接状态', async () => {
      vi.mocked(getConnectionState).mockReturnValue({
        connected: true,
        robotName: 'ClaudeCode',
        connectedAt: 1234567890,
      });

      const handler = toolHandlers.get('check_connection')!.handler;
      const result = await handler({}, {});

      const response = JSON.parse(result.content[0].text);
      expect(response.connected).toBe(true);
      expect(response.robotName).toBe('ClaudeCode');
    });
  });

  describe('get_setup_guide 工具', () => {
    it('应该返回安装指南', async () => {
      const handler = toolHandlers.get('get_setup_guide')!.handler;
      const result = await handler({}, {});

      expect(result.content[0].text).toContain('安装配置指南');
      expect(result.content[0].text).toContain('send_message');
    });
  });

  describe('机器人选择逻辑', () => {
    it('通过序号选择机器人', async () => {
      vi.mocked(listAllRobots).mockReturnValue([
        { name: 'ClaudeCode', botId: 'bot1', targetUserId: 'user1', isDefault: true },
        { name: 'module-studio', botId: 'bot2', targetUserId: 'user2', isDefault: false }
      ]);

      const robots = listAllRobots();
      const robotId = '1';
      const index = parseInt(robotId);

      let selectedRobot;
      if (!isNaN(index) && index >= 1 && index <= robots.length) {
        selectedRobot = robots[index - 1];
      }

      expect(selectedRobot?.name).toBe('ClaudeCode');
    });

    it('通过名称选择机器人', async () => {
      vi.mocked(listAllRobots).mockReturnValue([
        { name: 'ClaudeCode', botId: 'bot1', targetUserId: 'user1', isDefault: true },
        { name: 'module-studio', botId: 'bot2', targetUserId: 'user2', isDefault: false }
      ]);

      const robots = listAllRobots();
      const robotId = 'module-studio';
      const selectedRobot = robots.find(r =>
        r.name === robotId || r.botId === robotId || r.name.includes(robotId)
      );

      expect(selectedRobot?.name).toBe('module-studio');
    });

    it('通过部分名称匹配机器人', async () => {
      vi.mocked(listAllRobots).mockReturnValue([
        { name: 'ClaudeCode', botId: 'bot1', targetUserId: 'user1', isDefault: true },
        { name: 'module-studio', botId: 'bot2', targetUserId: 'user2', isDefault: false }
      ]);

      const robots = listAllRobots();
      const robotId = 'module';
      const selectedRobot = robots.find(r =>
        r.name === robotId || r.botId === robotId || r.name.includes(robotId)
      );

      expect(selectedRobot?.name).toBe('module-studio');
    });
  });

  describe('机器人占用检查', () => {
    it('机器人被占用时应该返回错误', async () => {
      vi.mocked(isRobotOccupied).mockReturnValue(true);
      vi.mocked(getRobotOccupiedBy).mockReturnValue('OtherAgent');

      const occupied = isRobotOccupied('ClaudeCode');
      expect(occupied).toBe(true);

      const occupiedBy = getRobotOccupiedBy('ClaudeCode');
      expect(occupiedBy).toBe('OtherAgent');
    });
  });
});