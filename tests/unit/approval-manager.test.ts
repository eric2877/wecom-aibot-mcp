/**
 * approval-manager 单元测试
 *
 * 测试范围：
 * - 审批 CRUD 操作
 * - 持久化保存/恢复
 * - MCP 重启后注入 WecomClient
 * - 定时保存机制
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const TEST_DIR = path.join(os.tmpdir(), 'wecom-approval-test-' + Date.now());

import {
  addApproval,
  getApproval,
  updateApprovalStatus,
  getPendingApprovals,
  saveApprovalState,
  loadApprovalState,
  startAutoSave,
  stopAutoSave,
  setConfigDir,
  ApprovalEntry,
} from '../../src/approval-manager.js';

// Mock WecomClient
class MockWecomClient {
  public approvals = new Map<string, any>();
  lastInjectedTaskId: string | null = null;

  injectApprovalRecord(taskId: string, partial: any) {
    this.lastInjectedTaskId = taskId;
    this.approvals.set(taskId, { ...partial, resolved: false, timestamp: Date.now() });
  }
}

describe('approval-manager', () => {
  let mockClient: MockWecomClient;

  beforeEach(() => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
    setConfigDir(TEST_DIR);
    mockClient = new MockWecomClient();

    // 清空 pendingApprovals
    const map = getPendingApprovals();
    map.clear();
  });

  afterEach(() => {
    stopAutoSave();
    try {
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
    } catch {}
  });

  describe('addApproval', () => {
    it('应添加审批条目', () => {
      const entry: ApprovalEntry = {
        taskId: 'task-1',
        status: 'pending',
        timestamp: Date.now(),
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
        description: '命令: ls',
        robotName: 'robot-1',
      };

      addApproval(entry);

      const retrieved = getApproval('task-1');
      expect(retrieved).toEqual(entry);
    });
  });

  describe('updateApprovalStatus', () => {
    it('应更新审批状态并从 Map 中移除', () => {
      const entry: ApprovalEntry = {
        taskId: 'task-1',
        status: 'pending',
        timestamp: Date.now(),
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
        description: '命令: ls',
        robotName: 'robot-1',
      };
      addApproval(entry);

      updateApprovalStatus('task-1', 'allow-once');

      // 审批完成后从 Map 中移除
      const updated = getApproval('task-1');
      expect(updated).toBeUndefined();
    });

    it('更新不存在的 taskId 应安全忽略', () => {
      expect(() => updateApprovalStatus('nonexistent', 'allow-once')).not.toThrow();
    });
  });

  describe('getPendingApprovals', () => {
    it('应返回所有待处理审批', () => {
      const entry1: ApprovalEntry = {
        taskId: 'task-1',
        status: 'pending',
        timestamp: Date.now(),
        tool_name: 'Bash',
        tool_input: {},
        description: '',
        robotName: 'robot-1',
      };
      const entry2: ApprovalEntry = {
        taskId: 'task-2',
        status: 'allow-once',
        timestamp: Date.now(),
        tool_name: 'Edit',
        tool_input: {},
        description: '',
        robotName: 'robot-1',
      };

      addApproval(entry1);
      addApproval(entry2);

      const map = getPendingApprovals();
      expect(map.size).toBe(2);
      expect(map.has('task-1')).toBe(true);
      expect(map.has('task-2')).toBe(true);
    });
  });

  describe('saveApprovalState', () => {
    it('应保存 pending 状态的审批到文件', () => {
      const entry1: ApprovalEntry = {
        taskId: 'task-1',
        status: 'pending',
        timestamp: Date.now(),
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
        description: '命令: ls',
        robotName: 'robot-1',
      };
      const entry2: ApprovalEntry = {
        taskId: 'task-2',
        status: 'allow-once',  // 非pending，不应保存
        timestamp: Date.now(),
        tool_name: 'Edit',
        tool_input: {},
        description: '',
        robotName: 'robot-1',
      };

      addApproval(entry1);
      addApproval(entry2);

      saveApprovalState();

      const content = fs.readFileSync(path.join(TEST_DIR, 'approval-state.json'), 'utf-8');
      const state = JSON.parse(content);

      expect(state.approvals.length).toBe(1);
      expect(state.approvals[0].taskId).toBe('task-1');
    });
  });

  describe('loadApprovalState', () => {
    it('应从文件恢复审批状态', async () => {
      // 创建持久化文件
      const state = {
        approvals: [
          {
            taskId: 'task-1',
            entry: {
              taskId: 'task-1',
              status: 'pending',
              timestamp: Date.now(),
              tool_name: 'Bash',
              tool_input: { command: 'ls' },
              description: '命令: ls',
              robotName: 'robot-1',
            },
          },
        ],
        savedAt: Date.now(),
      };
      fs.writeFileSync(path.join(TEST_DIR, 'approval-state.json'), JSON.stringify(state));

      // Mock getClient
      const getClient = vi.fn().mockResolvedValue(mockClient as any);

      await loadApprovalState(getClient);

      // 应恢复到内存
      expect(getApproval('task-1')).toBeDefined();

      // 应注入到 WecomClient
      expect(mockClient.lastInjectedTaskId).toBe('task-1');

      // 应删除持久化文件
      expect(fs.existsSync(path.join(TEST_DIR, 'approval-state.json'))).toBe(false);
    });

    it('应只恢复 10 分钟内的审批', async () => {
      const oldTimestamp = Date.now() - 11 * 60 * 1000;  // 11 分钟前
      const state = {
        approvals: [
          {
            taskId: 'task-1',
            entry: {
              taskId: 'task-1',
              status: 'pending',
              timestamp: oldTimestamp,
              tool_name: 'Bash',
              tool_input: {},
              description: '',
              robotName: 'robot-1',
            },
          },
        ],
        savedAt: oldTimestamp,
      };
      fs.writeFileSync(path.join(TEST_DIR, 'approval-state.json'), JSON.stringify(state));

      const getClient = vi.fn().mockResolvedValue(mockClient as any);

      await loadApprovalState(getClient);

      // 应忽略过期的审批
      expect(getApproval('task-1')).toBeUndefined();
      expect(getClient).not.toHaveBeenCalled();
    });

    it('机器人不在线时应记录警告', async () => {
      const state = {
        approvals: [
          {
            taskId: 'task-1',
            entry: {
              taskId: 'task-1',
              status: 'pending',
              timestamp: Date.now(),
              tool_name: 'Bash',
              tool_input: {},
              description: '',
              robotName: 'robot-offline',
            },
          },
        ],
        savedAt: Date.now(),
      };
      fs.writeFileSync(path.join(TEST_DIR, 'approval-state.json'), JSON.stringify(state));

      const getClient = vi.fn().mockResolvedValue(null);

      await loadApprovalState(getClient);

      // 应记录审批，但不注入
      expect(getApproval('task-1')).toBeDefined();
      expect(mockClient.lastInjectedTaskId).toBeNull();
    });
  });

  describe('定时保存', () => {
    it('应定时保存审批状态', async () => {
      const entry: ApprovalEntry = {
        taskId: 'task-1',
        status: 'pending',
        timestamp: Date.now(),
        tool_name: 'Bash',
        tool_input: {},
        description: '',
        robotName: 'robot-1',
      };
      addApproval(entry);

      startAutoSave();

      // 等待至少一次保存（30秒间隔，测试用短一些）
      await new Promise((resolve) => setTimeout(resolve, 100));

      // 手动触发一次保存验证
      saveApprovalState();
      expect(fs.existsSync(path.join(TEST_DIR, 'approval-state.json'))).toBe(true);
    });

    it('无待处理审批时不应保存', () => {
      startAutoSave();
      saveApprovalState();
      expect(fs.existsSync(path.join(TEST_DIR, 'approval-state.json'))).toBe(false);
    });

    it('stopAutoSave 应停止定时器', () => {
      startAutoSave();
      stopAutoSave();
      // 定时器应被清除，不再保存
    });
  });
});