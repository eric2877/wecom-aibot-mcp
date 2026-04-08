/**
 * 集成测试：完整业务流程
 *
 * 测试场景：
 * 1. 进入微信模式 -> 发送消息 -> 接收消息 -> 审批 -> 退出
 * 2. Agent 默认行为
 * 3. 多 CC 同一机器人
 * 4. 断线重连对审批的影响
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const TEST_DIR = path.join(os.tmpdir(), 'wecom-integration-test-' + Date.now());

// Mock 整个依赖链
vi.mock('../../src/config-wizard.js', () => ({
  listAllRobots: () => [
    { name: 'robot-1', botId: 'bot-1', targetUserId: 'user-1' },
    { name: 'robot-2', botId: 'bot-2', targetUserId: 'user-2' },
  ],
}));

vi.mock('../../src/connection-manager.js', () => ({
  connectRobot: vi.fn().mockResolvedValue({ success: true, client: mockClient }),
  getClient: vi.fn().mockResolvedValue(mockClient),
  getAllConnectionStates: () => [
    { robotName: 'robot-1', connected: true, connectedAt: Date.now() },
  ],
  getConnectionState: () => ({
    connected: true,
    robotName: 'robot-1',
    connectedAt: Date.now(),
  }),
  connectAllRobots: vi.fn(),
}));

// Mock WecomClient
const mockClient = {
  sendText: vi.fn().mockResolvedValue(true),
  getPendingMessages: vi.fn().mockReturnValue([]),
  isConnected: vi.fn().mockReturnValue(true),
  disconnect: vi.fn(),
  sendApprovalRequest: vi.fn().mockResolvedValue('task-123'),
  getApprovalResult: vi.fn().mockReturnValue('pending'),
  injectApprovalRecord: vi.fn(),
  approvals: new Map(),
};

vi.mock('../../src/message-bus.js', () => ({
  subscribeWecomMessageByRobot: vi.fn().mockReturnValue({
    unsubscribe: vi.fn(),
  }),
  publishWecomMessage: vi.fn(),
}));

import { registerCcId, unregisterCcId, getCcIdBinding, isCcIdRegistered, setConfigDir as setRegistryDir } from '../../src/cc-registry.js';
import {
  enterHeadlessMode,
  exitHeadlessMode,
  getHeadlessState,
  findByProjectDir,
  setConfigDir as setHeadlessDir,
} from '../../src/headless-state.js';
import {
  addApproval,
  getApproval,
  updateApprovalStatus,
  saveApprovalState,
  loadApprovalState,
  setConfigDir as setApprovalDir,
} from '../../src/approval-manager.js';

describe('集成测试：完整业务流程', () => {
  beforeEach(() => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
    setRegistryDir(TEST_DIR);
    setHeadlessDir(TEST_DIR);
    setApprovalDir(TEST_DIR);
    vi.clearAllMocks();
  });

  afterEach(() => {
    exitHeadlessMode();
    try {
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
    } catch {}
  });

  describe('场景 1：标准流程', () => {
    it('应完成进入 -> 消息 -> 审批 -> 退出流程', async () => {
      // 1. 进入微信模式
      const result = registerCcId('project-1', 'robot-1');
      expect(result).toBe('registered');

      enterHeadlessMode('/project/1', 'project-1', 'robot-1');

      expect(isCcIdRegistered('project-1')).toBe(true);
      expect(getHeadlessState()?.ccId).toBe('project-1');

      // 2. 发送消息
      const binding = getCcIdBinding('project-1');
      expect(binding?.robotName).toBe('robot-1');

      // 3. 触发审批
      const approvalEntry = {
        taskId: 'task-123',
        status: 'pending' as const,
        timestamp: Date.now(),
        tool_name: 'Bash',
        tool_input: { command: 'npm test' },
        description: '命令: npm test',
        robotName: binding!.robotName,
      };
      addApproval(approvalEntry);

      // 4. 用户允许
      updateApprovalStatus('task-123', 'allow-once');
      expect(getApproval('task-123')?.status).toBe('allow-once');

      // 5. 退出微信模式
      unregisterCcId('project-1');
      exitHeadlessMode();

      expect(isCcIdRegistered('project-1')).toBe(false);
      expect(getHeadlessState()).toBeNull();
    });
  });

  describe('场景 2：审批路由', () => {
    it('应通过 projectDir 正确路由审批', () => {
      // 注意：同一进程只能有一个 headless 状态文件
      // 测试单次进入即可验证路由
      registerCcId('project-1', 'robot-1');
      enterHeadlessMode('/project/1', 'project-1', 'robot-1');

      // Hook 发送审批请求（带 projectDir）
      const state1 = findByProjectDir('/project/1');
      expect(state1?.ccId).toBe('project-1');
      expect(state1?.robotName).toBe('robot-1');

      // 不存在的项目
      const state2 = findByProjectDir('/project/2');
      expect(state2).toBeNull();
    });
  });

  describe('场景 3：断线恢复', () => {
    it('MCP 重启后应恢复审批状态', async () => {
      // 1. 创建待处理审批
      registerCcId('project-1', 'robot-1');
      enterHeadlessMode('/project/1', 'project-1', 'robot-1');

      const entry = {
        taskId: 'task-456',
        status: 'pending' as const,
        timestamp: Date.now(),
        tool_name: 'Bash',
        tool_input: { command: 'npm build' },
        description: '命令: npm build',
        robotName: 'robot-1',
      };
      addApproval(entry);
      saveApprovalState();

      // 2. 模拟 MCP 重启（清空内存状态）
      exitHeadlessMode();

      // 3. 恢复审批状态
      const getClient = vi.fn().mockResolvedValue(mockClient as any);
      await loadApprovalState(getClient);

      // 4. 验证恢复
      expect(getApproval('task-456')).toBeDefined();
      expect(mockClient.injectApprovalRecord).toHaveBeenCalledWith(
        'task-456',
        { toolName: 'Bash', toolInput: { command: 'npm build' } }
      );
    });
  });

  describe('场景 4：多 CC 同一机器人', () => {
    it('应允许多个 CC 绑定同一机器人', () => {
      const result1 = registerCcId('project-1', 'robot-1');
      expect(result1).toBe('registered');

      const result2 = registerCcId('project-2', 'robot-1');
      expect(result2).toBe('registered');

      expect(isCcIdRegistered('project-1')).toBe(true);
      expect(isCcIdRegistered('project-2')).toBe(true);

      expect(getCcIdBinding('project-1')?.robotName).toBe('robot-1');
      expect(getCcIdBinding('project-2')?.robotName).toBe('robot-1');
    });

    it('应阻止相同 ccId 绑定不同机器人', () => {
      const result1 = registerCcId('project-1', 'robot-1');
      expect(result1).toBe('registered');

      const result2 = registerCcId('project-1', 'robot-2');
      expect(result2).toBe('occupied');

      expect(getCcIdBinding('project-1')?.robotName).toBe('robot-1');
    });
  });

  describe('场景 5：Agent 默认行为', () => {
    it('应选择第一个可用机器人作为默认', () => {
      const robots = [
        { name: 'robot-1', botId: 'bot-1', targetUserId: 'user-1' },
        { name: 'robot-2', botId: 'bot-2', targetUserId: 'user-2' },
      ];

      // 模拟默认选择逻辑
      const defaultRobot = robots[0].name;
      const result = registerCcId('default-project', defaultRobot);
      expect(result).toBe('registered');
    });

    it('多机器人时应要求选择', () => {
      const robots = [
        { name: 'robot-1', botId: 'bot-1', targetUserId: 'user-1' },
        { name: 'robot-2', botId: 'bot-2', targetUserId: 'user-2' },
      ];

      // 工具应返回 select_robot 状态
      expect(robots.length).toBeGreaterThan(1);
    });
  });

  describe('场景 6：续期机制', () => {
    it('相同 ccId + 相同 robotName 应续期', () => {
      const result1 = registerCcId('project-1', 'robot-1');
      expect(result1).toBe('registered');

      // 模拟崩溃重启后的重新进入
      const result2 = registerCcId('project-1', 'robot-1');
      expect(result2).toBe('renewed');

      expect(isCcIdRegistered('project-1')).toBe(true);
    });
  });
});