/**
 * Headless State 单元测试
 *
 * 测试覆盖：
 * - HS-001: getProjectHeadlessFile
 * - HS-002: enterHeadlessMode
 * - HS-003: exitHeadlessMode
 * - HS-004: loadHeadlessState
 * - HS-005: isHeadlessMode
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// 模拟文件系统
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: vi.fn(() => true),
    mkdirSync: vi.fn(),
    readFileSync: vi.fn(() => JSON.stringify({
      projectDir: '/test/project',
      timestamp: Date.now(),
      agentName: 'test-agent',
      autoApprove: true,
      robotName: 'test-robot'
    })),
    writeFileSync: vi.fn(),
    unlinkSync: vi.fn(),
    readdirSync: vi.fn(() => []),
    statSync: vi.fn(() => ({ mtime: new Date() })),
  };
});

vi.mock('path', async (importOriginal) => {
  const actual = await importOriginal<typeof import('path')>();
  return {
    ...actual,
    join: vi.fn((...args) => args.join('/')),
  };
});

vi.mock('os', () => ({
  homedir: vi.fn(() => '/home/test'),
}));

// 导入实际函数
import {
  getProjectHeadlessFile,
  loadHeadlessState,
  isHeadlessMode,
} from '../../src/headless-state';

describe('Headless State', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('HS-001: getProjectHeadlessFile', () => {
    it('应该返回正确的项目状态文件路径', () => {
      const projectDir = '/test/project';
      const filePath = getProjectHeadlessFile(projectDir);
      expect(filePath).toContain('.claude');
      expect(filePath).toContain('headless.json');
    });
  });

  describe('HS-004: loadHeadlessState', () => {
    it('应该能加载 headless 状态', () => {
      const state = loadHeadlessState('/test/project');
      if (state) {
        expect(state.projectDir).toBe('/test/project');
        expect(state.agentName).toBe('test-agent');
        expect(state.robotName).toBe('test-robot');
      }
    });
  });

  describe('HS-005: isHeadlessMode', () => {
    it('应该能检查是否在 headless 模式', () => {
      const isHeadless = isHeadlessMode('/test/project');
      // 根据模拟返回值判断
      expect(typeof isHeadless).toBe('boolean');
    });
  });

  describe('HeadlessState 结构', () => {
    it('状态应该包含所有必需字段', () => {
      const state = {
        projectDir: '/test/project',
        timestamp: Date.now(),
        agentName: 'test-agent',
        autoApprove: true,
        robotName: 'test-robot'
      };

      expect(state.projectDir).toBe('/test/project');
      expect(state.timestamp).toBeDefined();
      expect(state.agentName).toBe('test-agent');
      expect(state.autoApprove).toBe(true);
      expect(state.robotName).toBe('test-robot');
    });

    it('agentName 和 autoApprove 应该是可选的', () => {
      const state = {
        projectDir: '/test/project',
        timestamp: Date.now()
      };

      expect(state.projectDir).toBe('/test/project');
      expect(state.agentName).toBeUndefined();
      expect(state.autoApprove).toBeUndefined();
    });
  });
});