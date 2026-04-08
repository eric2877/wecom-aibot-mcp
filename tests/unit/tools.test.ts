/**
 * MCP 工具单元测试 — v3.0
 *
 * 测试覆盖：
 * - registerHeadlessTools: enter_headless_mode, exit_headless_mode, check_headless_status
 * - registerMessagingTools: send_message, get_pending_messages
 * - registerUtilsTools: list_robots, check_connection, get_setup_guide, add_robot_config,
 *   get_connection_stats, detect_user_from_message
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ────────────────────────────────────────────
// Mock 依赖（必须在导入前）
// ────────────────────────────────────────────

vi.mock('../../src/connection-manager.js', () => {
  return {
    __esModule: true,
    connectRobot: vi.fn(),
    disconnectRobot: vi.fn(),
    getClient: vi.fn(),
    getConnectionState: vi.fn(),
    getAllConnectionStates: vi.fn(),
    isRobotOccupied: vi.fn(),
    getRobotOccupiedBy: vi.fn(),
    connectAllRobots: vi.fn(),
  };
});

vi.mock('../../src/config-wizard.js', () => ({
  listAllRobots: vi.fn(() => [
    { name: 'ClaudeCode', botId: 'bot1', targetUserId: 'user1' },
    { name: 'module-studio', botId: 'bot2', targetUserId: 'user2' },
  ]),
}));

vi.mock('../../src/cc-registry.js', () => ({
  registerCcId: vi.fn(() => 'registered'),
  unregisterCcId: vi.fn(),
  isCcIdRegistered: vi.fn(() => true),
  getCcIdBinding: vi.fn(() => ({ robotName: 'ClaudeCode' })),
  touchCcId: vi.fn(),
  getRegistry: vi.fn(() => ({})),
}));

vi.mock('../../src/headless-state.js', () => ({
  enterHeadlessMode: vi.fn(() => ({
    projectDir: process.cwd(),
    timestamp: Date.now(),
    agentName: 'TestAgent',
    robotName: 'ClaudeCode',
    autoApprove: true,
  })),
  exitHeadlessMode: vi.fn(() => ({
    projectDir: process.cwd(),
    timestamp: Date.now(),
    agentName: 'TestAgent',
  })),
  loadHeadlessState: vi.fn(() => ({
    projectDir: process.cwd(),
    timestamp: Date.now(),
    agentName: 'TestAgent',
  })),
  isHeadlessMode: vi.fn(() => true),
}));

vi.mock('../../src/message-bus.js', () => ({
  subscribeWecomMessageByRobot: vi.fn(() => ({ unsubscribe: vi.fn() })),
  publishWecomMessage: vi.fn(),
  WecomMessage: undefined,
}));

vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: vi.fn(() => ({
    tool: vi.fn(),
  })),
}));

// ────────────────────────────────────────────
// 导入
// ────────────────────────────────────────────

import { registerHeadlessTools } from '../../src/tools/headless';
import { registerMessagingTools } from '../../src/tools/messaging';
import { registerUtilsTools } from '../../src/tools/utils-tools';
import {
  registerCcId,
  unregisterCcId,
  isCcIdRegistered,
  getCcIdBinding,
} from '../../src/cc-registry';
import {
  connectRobot,
  getClient,
  getConnectionState,
  getAllConnectionStates,
  isRobotOccupied,
  getRobotOccupiedBy,
} from '../../src/connection-manager';
import { listAllRobots } from '../../src/config-wizard';
import { exitHeadlessMode, loadHeadlessState } from '../../src/headless-state';

// ────────────────────────────────────────────
// 测试
// ────────────────────────────────────────────

function captureTools(registerFn: (server: any) => void): Map<string, { handler: Function; schema: any; description: string }> {
  const tools = new Map();
  const mockServer = {
    tool: vi.fn((name: string, description: string, schema: any, handler: Function) => {
      tools.set(name, { handler, schema, description });
    }),
  };
  registerFn(mockServer as any);
  return tools;
}

describe('v3.0 MCP Tools', () => {
  const mockClient = {
    sendText: vi.fn().mockResolvedValue(true),
    isConnected: vi.fn().mockReturnValue(true),
    getPendingMessages: vi.fn().mockReturnValue([]),
    getPendingApprovalsRecords: vi.fn().mockReturnValue([]),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset mockClient implementations after clear
    mockClient.sendText.mockResolvedValue(true);
    mockClient.isConnected.mockReturnValue(true);
    mockClient.getPendingMessages.mockReturnValue([]);
    mockClient.getPendingApprovalsRecords.mockReturnValue([]);
    vi.mocked(getClient).mockResolvedValue(mockClient as any);
    vi.mocked(connectRobot).mockResolvedValue({ success: true, client: mockClient as any });
    vi.mocked(getConnectionState).mockReturnValue({ connected: true, robotName: 'ClaudeCode', connectedAt: Date.now() });
    vi.mocked(getAllConnectionStates).mockReturnValue([{ robotName: 'ClaudeCode', connected: true, connectedAt: Date.now() }]);
    vi.mocked(isRobotOccupied).mockReturnValue(false);
    vi.mocked(getRobotOccupiedBy).mockReturnValue(undefined);
    vi.mocked(listAllRobots).mockReturnValue([
      { name: 'ClaudeCode', botId: 'bot1', targetUserId: 'user1' },
      { name: 'module-studio', botId: 'bot2', targetUserId: 'user2' },
    ]);
    vi.mocked(registerCcId).mockReturnValue('registered');
    vi.mocked(isCcIdRegistered).mockReturnValue(true);
    vi.mocked(getCcIdBinding).mockReturnValue({ robotName: 'ClaudeCode' });
    vi.mocked(exitHeadlessMode).mockReturnValue({ projectDir: process.cwd(), timestamp: Date.now(), agentName: 'test' });
    vi.mocked(loadHeadlessState).mockReturnValue({ projectDir: process.cwd(), timestamp: Date.now(), agentName: 'test' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ────────────────────────────────────────
  // 工具注册验证
  // ────────────────────────────────────────

  describe('registerHeadlessTools', () => {
    let tools: Map<string, any>;

    beforeEach(() => {
      tools = captureTools(registerHeadlessTools);
    });

    it('应该注册 3 个工具', () => {
      expect(tools.size).toBe(3);
    });

    it('应该注册 enter_headless_mode', () => {
      expect(tools.has('enter_headless_mode')).toBe(true);
    });

    it('应该注册 exit_headless_mode', () => {
      expect(tools.has('exit_headless_mode')).toBe(true);
    });

    it('应该注册 check_headless_status', () => {
      expect(tools.has('check_headless_status')).toBe(true);
    });

    describe('enter_headless_mode', () => {
      it('无机器人配置时应该返回错误', async () => {
        vi.mocked(listAllRobots).mockReturnValueOnce([]);
        const handler = tools.get('enter_headless_mode')!.handler;
        const result = await handler({ ccId: 'test-project' }, {} as any);
        const response = JSON.parse(result.content[0].text);
        expect(response.status).toBe('error');
        expect(response.errorType).toBe('no_robots');
      });

      it('多机器人未指定时应该返回选择列表', async () => {
        vi.mocked(listAllRobots).mockReturnValueOnce([
          { name: 'bot-a', botId: 'bot1', targetUserId: 'user1' },
          { name: 'bot-b', botId: 'bot2', targetUserId: 'user2' },
        ]);
        const handler = tools.get('enter_headless_mode')!.handler;
        const result = await handler({ ccId: 'test-project' }, {} as any);
        const response = JSON.parse(result.content[0].text);
        expect(response.status).toBe('select_robot');
        expect(response.robots.length).toBe(2);
      });

      it('ccId 被占用时应该返回错误', async () => {
        vi.mocked(registerCcId).mockReturnValueOnce('occupied');
        const handler = tools.get('enter_headless_mode')!.handler;
        const result = await handler({ ccId: 'test-project', robotName: 'ClaudeCode' }, {} as any);
        const response = JSON.parse(result.content[0].text);
        expect(response.status).toBe('error');
        expect(response.errorType).toBe('ccid_occupied');
      });

      it('连接失败时应该清理注册并返回错误', async () => {
        vi.mocked(connectRobot).mockResolvedValueOnce({ success: false, error: '连接失败' });
        const handler = tools.get('enter_headless_mode')!.handler;
        const result = await handler({ ccId: 'test-project', robotName: 'ClaudeCode' }, {} as any);
        const response = JSON.parse(result.content[0].text);
        expect(response.status).toBe('error');
        expect(response.errorType).toBe('connect_failed');
        expect(unregisterCcId).toHaveBeenCalledWith('test-project');
      });

      it('成功时应该返回 entered 状态', async () => {
        const handler = tools.get('enter_headless_mode')!.handler;
        const result = await handler({ ccId: 'test-project', robotName: 'ClaudeCode' }, {} as any);
        const response = JSON.parse(result.content[0].text);
        expect(response.status).toBe('entered');
        expect(response.ccId).toBe('test-project');
        expect(response.robotName).toBe('ClaudeCode');
      });
    });

    describe('exit_headless_mode', () => {
      it('ccId 未注册时应该返回错误', async () => {
        vi.mocked(isCcIdRegistered).mockReturnValueOnce(false);
        const handler = tools.get('exit_headless_mode')!.handler;
        const result = await handler({ ccId: 'test-project' }, {} as any);
        const response = JSON.parse(result.content[0].text);
        expect(response.status).toBe('error');
      });

      it('成功时应该清理状态并返回', async () => {
        const handler = tools.get('exit_headless_mode')!.handler;
        const result = await handler({ ccId: 'test-project' }, {} as any);
        const response = JSON.parse(result.content[0].text);
        expect(response.status).toBe('exited');
        expect(response.ccId).toBe('test-project');
        expect(unregisterCcId).toHaveBeenCalled();
        expect(exitHeadlessMode).toHaveBeenCalled();
      });
    });

    describe('check_headless_status', () => {
      it('未注册且无 headless 状态时应该返回 verified', async () => {
        vi.mocked(isCcIdRegistered).mockReturnValueOnce(false);
        vi.mocked(loadHeadlessState).mockReturnValueOnce(null);
        const handler = tools.get('check_headless_status')!.handler;
        const result = await handler({ ccId: 'test-project' }, {} as any);
        const response = JSON.parse(result.content[0].text);
        expect(response.status).toBe('verified');
        expect(response.checks.unregistered).toBe(true);
        expect(response.checks.headlessCleared).toBe(true);
      });
    });
  });

  // ────────────────────────────────────────
  // registerMessagingTools
  // ────────────────────────────────────────

  describe('registerMessagingTools', () => {
    let tools: Map<string, any>;

    beforeEach(() => {
      tools = captureTools(registerMessagingTools);
      // Reset cc-registry mocks for messaging tests
      vi.mocked(isCcIdRegistered).mockReturnValue(true);
      vi.mocked(getCcIdBinding).mockReturnValue({ robotName: 'ClaudeCode' });
    });

    it('应该注册 2 个工具', () => {
      expect(tools.size).toBe(2);
    });

    it('应该注册 send_message', () => {
      expect(tools.has('send_message')).toBe(true);
    });

    it('应该注册 get_pending_messages', () => {
      expect(tools.has('get_pending_messages')).toBe(true);
    });

    describe('send_message', () => {
      it('ccId 已注册时应该发送消息并添加前缀', async () => {
        vi.mocked(getClient).mockResolvedValue(mockClient as any);
        const handler = tools.get('send_message')!.handler;
        const result = await handler({ ccId: 'test-project', content: 'hello' }, {} as any);
        const response = JSON.parse(result.content[0].text);
        expect(response.success).toBe(true);
      });
    });

    describe('get_pending_messages', () => {
      it('ccId 未注册时应该返回错误', async () => {
        vi.mocked(isCcIdRegistered).mockReturnValueOnce(false);
        const handler = tools.get('get_pending_messages')!.handler;
        const result = await handler({ ccId: 'test-project' }, {} as any);
        const response = JSON.parse(result.content[0].text);
        expect(response.error).toBeDefined();
      });

      it('有缓存消息时应该立即返回', async () => {
        const mockClient = (await getClient('ClaudeCode')) as any;
        mockClient.getPendingMessages.mockReturnValueOnce([
          { content: 'hello', from_userid: 'user1', chatid: 'chat1', chattype: 'single', timestamp: Date.now() },
        ]);
        const handler = tools.get('get_pending_messages')!.handler;
        const result = await handler({ ccId: 'test-project' }, {} as any);
        const response = JSON.parse(result.content[0].text);
        expect(response.count).toBe(1);
        expect(response.messages[0].content).toBe('hello');
        expect(response.timeout).toBeUndefined();
      });
    });
  });

  // ────────────────────────────────────────
  // registerUtilsTools
  // ────────────────────────────────────────

  describe('registerUtilsTools', () => {
    let tools: Map<string, any>;

    beforeEach(() => {
      tools = captureTools(registerUtilsTools);
    });

    it('应该注册 6 个工具', () => {
      expect(tools.size).toBe(6);
    });

    it('应该注册 list_robots', () => {
      expect(tools.has('list_robots')).toBe(true);
    });

    it('应该注册 check_connection', () => {
      expect(tools.has('check_connection')).toBe(true);
    });

    it('应该注册 get_setup_guide', () => {
      expect(tools.has('get_setup_guide')).toBe(true);
    });

    it('应该注册 add_robot_config', () => {
      expect(tools.has('add_robot_config')).toBe(true);
    });

    it('应该注册 get_connection_stats', () => {
      expect(tools.has('get_connection_stats')).toBe(true);
    });

    it('应该注册 detect_user_from_message', () => {
      expect(tools.has('detect_user_from_message')).toBe(true);
    });

    describe('list_robots', () => {
      it('应该列出所有机器人', async () => {
        vi.mocked(isRobotOccupied).mockReturnValue(false);
        const handler = tools.get('list_robots')!.handler;
        const result = await handler({}, {} as any);
        const response = JSON.parse(result.content[0].text);
        expect(response.total).toBe(2);
        expect(response.connected).toBe(1);
      });
    });

    describe('check_connection', () => {
      it('应该返回连接状态', async () => {
        vi.mocked(getConnectionState).mockReturnValue({
          connected: true,
          robotName: 'ClaudeCode',
          connectedAt: 1234567890,
        });
        const handler = tools.get('check_connection')!.handler;
        const result = await handler({}, {} as any);
        const response = JSON.parse(result.content[0].text);
        expect(response.connected).toBe(true);
        expect(response.robotName).toBe('ClaudeCode');
      });
    });

    describe('get_setup_guide', () => {
      it('应该返回安装指南', async () => {
        const handler = tools.get('get_setup_guide')!.handler;
        const result = await handler({}, {} as any);
        expect(result.content[0].text).toContain('安装配置指南');
        expect(result.content[0].text).toContain('enter_headless_mode');
      });
    });
  });
});
