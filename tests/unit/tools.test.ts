/**
 * MCP 工具单元测试
 *
 * 测试覆盖：
 * - T-001 ~ T-010: 各种工具场景
 * - 完整工具执行流程
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// 模拟依赖（必须在导入前）
vi.mock('../../src/connection-manager.js', () => ({
  connectRobot: vi.fn().mockResolvedValue({
    success: true,
    client: {
      sendText: vi.fn().mockResolvedValue(true),
      getPendingMessages: vi.fn().mockReturnValue([]),
      isConnected: vi.fn().mockReturnValue(true),
    }
  }),
  disconnectRobot: vi.fn(),
  getClient: vi.fn().mockResolvedValue({
    sendText: vi.fn().mockResolvedValue(true),
    getPendingMessages: vi.fn().mockReturnValue([]),
    isConnected: vi.fn().mockReturnValue(true),
  }),
  getConnectionState: vi.fn(() => ({ connected: true, robotName: 'ClaudeCode', connectedAt: Date.now() })),
}));

vi.mock('../../src/config-wizard.js', () => ({
  listAllRobots: vi.fn(() => [
    { name: 'ClaudeCode', botId: 'bot1', targetUserId: 'user1' },
    { name: 'module-studio', botId: 'bot2', targetUserId: 'user2' }
  ]),
}));

vi.mock('../../src/http-server.js', () => ({
  registerCcId: vi.fn(),
  unregisterCcId: vi.fn(),
  getRobotByCcId: vi.fn(),
}));

vi.mock('../../src/headless-state.js', () => ({
  enterHeadlessMode: vi.fn(),
  exitHeadlessMode: vi.fn(),
  isHeadlessMode: vi.fn(),
}));

vi.mock('../../src/project-config.js', () => ({
  updateWechatModeConfig: vi.fn(),
  addPermissionHook: vi.fn(),
  removePermissionHook: vi.fn(),
  addTaskCompletedHook: vi.fn(),
  removeTaskCompletedHook: vi.fn(),
}));

vi.mock('../../src/message-bus.js', () => ({
  subscribeWecomMessageByRobot: vi.fn(),
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
} from '../../src/connection-manager';
import {
  registerCcId,
  unregisterCcId,
  getRobotByCcId,
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
    it('应该注册正确数量的工具', () => {
      // 当前注册的工具数量：10 个
      expect(toolHandlers.size).toBe(10);
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

    it('应该注册 list_robots 工具', () => {
      expect(toolHandlers.has('list_robots')).toBe(true);
    });

    it('应该注册 check_connection 工具', () => {
      expect(toolHandlers.has('check_connection')).toBe(true);
    });

    it('应该注册 get_setup_guide 工具', () => {
      expect(toolHandlers.has('get_setup_guide')).toBe(true);
    });

    it('应该注册 get_pending_messages 工具', () => {
      expect(toolHandlers.has('get_pending_messages')).toBe(true);
    });

    it('应该注册 detect_user_from_message 工具', () => {
      expect(toolHandlers.has('detect_user_from_message')).toBe(true);
    });

    it('应该注册 add_robot_config 工具', () => {
      expect(toolHandlers.has('add_robot_config')).toBe(true);
    });
  });

  describe('send_message 工具', () => {
    it('有 cc_id 时应该调用 getClient', async () => {
      vi.mocked(getRobotByCcId).mockReturnValue('ClaudeCode');

      const handler = toolHandlers.get('send_message')!.handler;
      await handler(
        { content: 'test message', cc_id: 'cc-1' }
      );

      expect(getClient).toHaveBeenCalledWith('ClaudeCode');
    });

    it('无 cc_id 时应该返回错误', async () => {
      const handler = toolHandlers.get('send_message')!.handler;
      const result = await handler(
        { content: 'test message' }
      );

      expect(result.content[0].text).toContain('未在微信模式');
    });
  });

  describe('enter_headless_mode 工具', () => {
    it('无机器人配置时应该返回错误', async () => {
      vi.mocked(listAllRobots).mockReturnValueOnce([]);

      const handler = toolHandlers.get('enter_headless_mode')!.handler;
      const result = await handler(
        { agent_name: 'TestAgent' }
      );

      const response = JSON.parse(result.content[0].text);
      expect(response.status).toBe('error');
    });

    it('多机器人未指定时应该返回选择列表', async () => {
      const handler = toolHandlers.get('enter_headless_mode')!.handler;
      const result = await handler(
        { cc_id: 'test-cc', agent_name: 'TestAgent' }
      );

      const response = JSON.parse(result.content[0].text);
      expect(response.status).toBe('select_robot');
      expect(response.robots.length).toBe(2);
    });

    it('连接成功时应该注册 ccId（由智能体传入）', async () => {
      vi.mocked(connectRobot).mockResolvedValueOnce({
        success: true,
        client: {
          sendText: vi.fn().mockResolvedValue(true),
        },
      } as any);

      const handler = toolHandlers.get('enter_headless_mode')!.handler;
      const result = await handler(
        { cc_id: 'my-project', agent_name: 'TestAgent', robot_id: '1', project_dir: '/path/to/test-project' }
      );

      // ccId 由智能体传入
      expect(registerCcId).toHaveBeenCalledWith('my-project', 'ClaudeCode', 'TestAgent');
    });

    it('连接失败时应该返回错误', async () => {
      vi.mocked(connectRobot).mockResolvedValueOnce({
        success: false,
        error: 'Connection failed',
      });

      const handler = toolHandlers.get('enter_headless_mode')!.handler;
      const result = await handler(
        { cc_id: 'test-cc', agent_name: 'TestAgent', robot_id: '1', project_dir: '/path/to/test-project' }
      );

      const response = JSON.parse(result.content[0].text);
      expect(response.status).toBe('error');
    });

    it('未指定 agent_name 时应使用 cc_id', async () => {
      vi.mocked(connectRobot).mockResolvedValueOnce({
        success: true,
        client: {
          sendText: vi.fn().mockResolvedValue(true),
        },
      } as any);

      const handler = toolHandlers.get('enter_headless_mode')!.handler;
      const result = await handler(
        { cc_id: 'my-project', robot_id: '1', project_dir: '/path/to/my-app' }
      );

      // agent_name 未指定，应使用 cc_id 'my-project'
      expect(connectRobot).toHaveBeenCalledWith('ClaudeCode', 'my-project');
    });
  });

  describe('exit_headless_mode 工具', () => {
    it('无 cc_id 时应该返回错误', async () => {
      vi.mocked(getRobotByCcId).mockReturnValue(null);

      const handler = toolHandlers.get('exit_headless_mode')!.handler;
      const result = await handler({});

      const response = JSON.parse(result.content[0].text);
      expect(response.status).toBe('error');
    });

    it('有 cc_id 且注册时应该断开连接', async () => {
      // 需要模拟 getClient 返回有效客户端
      vi.mocked(getRobotByCcId).mockReturnValue('ClaudeCode');
      vi.mocked(getClient).mockResolvedValueOnce({
        sendText: vi.fn().mockResolvedValue(true),
        isConnected: vi.fn().mockReturnValue(true),
      } as any);

      const handler = toolHandlers.get('exit_headless_mode')!.handler;
      const result = await handler({ cc_id: 'cc-1' });

      expect(disconnectRobot).toHaveBeenCalled();
      expect(unregisterCcId).toHaveBeenCalledWith('cc-1');
    });

    it('应该返回退出状态', async () => {
      vi.mocked(getRobotByCcId).mockReturnValue('ClaudeCode');
      vi.mocked(getClient).mockResolvedValueOnce({
        sendText: vi.fn().mockResolvedValue(true),
        isConnected: vi.fn().mockReturnValue(true),
      } as any);

      const handler = toolHandlers.get('exit_headless_mode')!.handler;
      const result = await handler({ cc_id: 'cc-1' });

      const response = JSON.parse(result.content[0].text);
      expect(response.status).toBe('exited');
      expect(response.robotName).toBe('ClaudeCode');
    });
  });

  describe('list_robots 工具', () => {
    it('应该列出所有机器人名称', async () => {
      const handler = toolHandlers.get('list_robots')!.handler;
      const result = await handler({}, {});

      const response = JSON.parse(result.content[0].text);
      expect(response.robots.length).toBe(2);
      expect(response.robots).toContain('ClaudeCode');
      expect(response.robots).toContain('module-studio');
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
        { name: 'ClaudeCode', botId: 'bot1', targetUserId: 'user1' },
        { name: 'module-studio', botId: 'bot2', targetUserId: 'user2' }
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
        { name: 'ClaudeCode', botId: 'bot1', targetUserId: 'user1' },
        { name: 'module-studio', botId: 'bot2', targetUserId: 'user2' }
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
        { name: 'ClaudeCode', botId: 'bot1', targetUserId: 'user1' },
        { name: 'module-studio', botId: 'bot2', targetUserId: 'user2' }
      ]);

      const robots = listAllRobots();
      const robotId = 'module';
      const selectedRobot = robots.find(r =>
        r.name === robotId || r.botId === robotId || r.name.includes(robotId)
      );

      expect(selectedRobot?.name).toBe('module-studio');
    });
  });
});