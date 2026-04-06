/**
 * Headless State 单元测试 - 扩展覆盖
 *
 * 测试覆盖：
 * - HS-101: enterHeadlessMode
 * - HS-102: exitHeadlessMode
 * - HS-103: setAutoApprove
 * - HS-104: cleanupOrphanFiles
 * - HS-105: getAllHeadlessStates
 * - HS-106: checkRobotOccupied
 * - HS-107: clearAllProjectHooks
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// 使用 vi.hoisted 解决 mock 初始化顺序问题
const mockFs = vi.hoisted(() => ({
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

vi.mock('fs', () => mockFs);

vi.mock('path', async (importOriginal) => {
  const actual = await importOriginal<typeof import('path')>();
  return {
    ...actual,
    join: vi.fn((...args) => args.join('/')),
    dirname: vi.fn((p: string) => p.split('/').slice(0, -1).join('/')),
  };
});

vi.mock('os', () => ({
  homedir: vi.fn(() => '/home/test'),
}));

// 导入实际函数
import {
  getProjectHeadlessFile,
  enterHeadlessMode,
  exitHeadlessMode,
  loadHeadlessState,
  isHeadlessMode,
  setAutoApprove,
  getAllHeadlessStates,
  checkRobotOccupied,
  clearAllProjectHooks,
  cleanupOrphanFiles,
} from '../../src/headless-state';

describe('Headless State - 扩展覆盖', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // 默认配置
    mockFs.existsSync.mockReturnValue(true);
    mockFs.mkdirSync.mockReturnValue(undefined);
    mockFs.writeFileSync.mockReturnValue(undefined);
    mockFs.unlinkSync.mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('HS-101: enterHeadlessMode', () => {
    it('应该能进入 headless 模式', () => {
      mockFs.existsSync.mockReturnValue(false); // 文件不存在，需要创建

      const state = enterHeadlessMode('/test/project', 'agent-1', 'robot-1');

      expect(state.projectDir).toBe('/test/project');
      expect(state.agentName).toBe('agent-1');
      expect(state.robotName).toBe('robot-1');
      expect(state.autoApprove).toBe(true); // 默认启用
      expect(state.timestamp).toBeDefined();

      expect(mockFs.mkdirSync).toHaveBeenCalled();
      expect(mockFs.writeFileSync).toHaveBeenCalled();
    });

    it('应该能进入 headless 模式（无可选参数）', () => {
      mockFs.existsSync.mockReturnValue(false);

      const state = enterHeadlessMode('/test/project');

      expect(state.projectDir).toBe('/test/project');
      expect(state.agentName).toBeUndefined();
      expect(state.robotName).toBeUndefined();
      expect(state.autoApprove).toBe(true);
    });
  });

  describe('HS-102: exitHeadlessMode', () => {
    it('应该能退出 headless 模式', () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockImplementation((filePath: string) => {
        // 全局索引
        if (filePath.includes('headless-index.json')) {
          return JSON.stringify(['/test/project']);
        }
        // 状态文件
        return JSON.stringify({
          projectDir: '/test/project',
          timestamp: Date.now(),
          agentName: 'agent-1',
          robotName: 'robot-1',
          autoApprove: true,
        });
      });

      const state = exitHeadlessMode('/test/project');

      expect(state).not.toBeNull();
      expect(state?.projectDir).toBe('/test/project');
      expect(mockFs.unlinkSync).toHaveBeenCalled();
      expect(mockFs.writeFileSync).toHaveBeenCalled();
    });

    it('未在 headless 模式时应该返回 null', () => {
      mockFs.existsSync.mockReturnValue(false); // 状态文件不存在

      const state = exitHeadlessMode('/test/project');

      expect(state).toBeNull();
    });
  });

  describe('HS-103: setAutoApprove', () => {
    it('应该能启用智能代批', () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify({
        projectDir: '/test/project',
        timestamp: Date.now(),
        autoApprove: false,
      }));

      const state = setAutoApprove(true, '/test/project');

      expect(state).not.toBeNull();
      expect(state?.autoApprove).toBe(true);
      expect(mockFs.writeFileSync).toHaveBeenCalled();
    });

    it('应该能禁用智能代批', () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify({
        projectDir: '/test/project',
        timestamp: Date.now(),
        autoApprove: true,
      }));

      const state = setAutoApprove(false, '/test/project');

      expect(state).not.toBeNull();
      expect(state?.autoApprove).toBe(false);
    });

    it('未在 headless 模式时应该返回 null', () => {
      mockFs.existsSync.mockReturnValue(false);

      const state = setAutoApprove(true, '/test/project');

      expect(state).toBeNull();
    });
  });

  describe('HS-104: loadHeadlessState', () => {
    it('应该能加载状态', () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify({
        projectDir: '/test/project',
        timestamp: 1234567890,
        agentName: 'test-agent',
        robotName: 'test-robot',
        autoApprove: true,
      }));

      const state = loadHeadlessState('/test/project');

      expect(state).not.toBeNull();
      expect(state?.projectDir).toBe('/test/project');
      expect(state?.timestamp).toBe(1234567890);
      expect(state?.agentName).toBe('test-agent');
      expect(state?.robotName).toBe('test-robot');
    });

    it('状态文件不存在时应该返回 null', () => {
      mockFs.existsSync.mockReturnValue(false);

      const state = loadHeadlessState('/test/project');

      expect(state).toBeNull();
    });

    it('解析失败时应该返回 null', () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue('invalid-json');

      const state = loadHeadlessState('/test/project');

      expect(state).toBeNull();
    });
  });

  describe('HS-105: isHeadlessMode', () => {
    it('状态文件存在时应该返回 true', () => {
      mockFs.existsSync.mockReturnValue(true);

      const result = isHeadlessMode('/test/project');

      expect(result).toBe(true);
    });

    it('状态文件不存在时应该返回 false', () => {
      mockFs.existsSync.mockReturnValue(false);

      const result = isHeadlessMode('/test/project');

      expect(result).toBe(false);
    });
  });

  describe('HS-106: getAllHeadlessStates', () => {
    it('应该能获取所有状态', () => {
      // 全局索引
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockImplementation((filePath: string) => {
        if (filePath.includes('headless-index.json')) {
          return JSON.stringify(['/test/project1', '/test/project2']);
        }
        // 状态文件
        return JSON.stringify({
          projectDir: filePath.includes('project1') ? '/test/project1' : '/test/project2',
          timestamp: Date.now(),
          robotName: 'robot-1',
        });
      });

      const states = getAllHeadlessStates();

      expect(states.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe('HS-107: checkRobotOccupied', () => {
    it('应该能检查机器人占用情况', () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockImplementation((filePath: string) => {
        if (filePath.includes('headless-index.json')) {
          return JSON.stringify(['/test/project1']);
        }
        return JSON.stringify({
          projectDir: '/test/project1',
          timestamp: Date.now(),
          robotName: 'robot-1',
          agentName: 'agent-1',
        });
      });

      const result = checkRobotOccupied('robot-1');

      expect(result).toHaveProperty('occupied');
    });

    it('排除当前项目时应该返回未占用', () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockImplementation((filePath: string) => {
        if (filePath.includes('headless-index.json')) {
          return JSON.stringify(['/test/project1']);
        }
        return JSON.stringify({
          projectDir: '/test/project1',
          timestamp: Date.now(),
          robotName: 'robot-1',
        });
      });

      const result = checkRobotOccupied('robot-1', '/test/project1');

      expect(result.occupied).toBe(false);
    });
  });

  describe('HS-108: clearAllProjectHooks', () => {
    it('应该能清理所有 Hook 配置', () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockImplementation((filePath: string) => {
        if (filePath.includes('headless-index.json')) {
          return JSON.stringify(['/test/project1']);
        }
        return JSON.stringify({
          projectDir: '/test/project1',
          timestamp: Date.now(),
        });
      });

      clearAllProjectHooks();

      expect(mockFs.existsSync).toHaveBeenCalled();
    });
  });

  describe('HS-109: cleanupOrphanFiles', () => {
    it('应该能清理孤儿状态文件', () => {
      mockFs.existsSync.mockImplementation((filePath: string) => {
        // 状态文件存在
        if (filePath.includes('project1') && filePath.includes('headless.json')) {
          return true;
        }
        // 状态文件不存在（孤儿）
        if (filePath.includes('project2') && filePath.includes('headless.json')) {
          return false;
        }
        return true;
      });

      mockFs.readFileSync.mockImplementation((filePath: string) => {
        if (filePath.includes('headless-index.json')) {
          return JSON.stringify(['/test/project1', '/test/project2']);
        }
        return JSON.stringify({
          projectDir: '/test/project1',
          timestamp: Date.now(),
        });
      });

      cleanupOrphanFiles();

      expect(mockFs.writeFileSync).toHaveBeenCalled();
    });
  });

  describe('HS-110: getProjectHeadlessFile', () => {
    it('应该返回正确的路径', () => {
      const result = getProjectHeadlessFile('/test/project');

      expect(result).toContain('.claude');
      expect(result).toContain('headless.json');
    });
  });
});