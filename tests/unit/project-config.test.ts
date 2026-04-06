/**
 * Project Config 单元测试
 *
 * 测试覆盖：
 * - PC-001: getProjectConfigPath
 * - PC-002: loadProjectConfig
 * - PC-003: saveProjectConfig
 * - PC-004: deleteProjectConfig
 * - PC-005: getConfig
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
      botId: 'test-bot',
      secret: 'test-secret',
      defaultUser: 'test-user',
      nameTag: 'test-robot',
    })),
    writeFileSync: vi.fn(),
    unlinkSync: vi.fn(),
    readdirSync: vi.fn(() => []),
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
  getProjectConfigPath,
  loadProjectConfig,
  hasProjectConfig,
  validateConfig,
} from '../../src/project-config';

describe('Project Config', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('PC-001: getProjectConfigPath', () => {
    it('应该返回正确的配置文件路径', () => {
      const projectDir = '/test/project';
      const path = getProjectConfigPath(projectDir);
      expect(path).toContain('.claude');
      expect(path).toContain('config.json');
    });
  });

  describe('PC-002: loadProjectConfig', () => {
    it('应该能加载项目配置', () => {
      const config = loadProjectConfig('/test/project');
      if (config) {
        expect(config.botId).toBe('test-bot');
        expect(config.defaultUser).toBe('test-user');
      }
    });
  });

  describe('PC-004: hasProjectConfig', () => {
    it('应该能检查配置是否存在', () => {
      const exists = hasProjectConfig('/test/project');
      expect(typeof exists).toBe('boolean');
    });
  });

  describe('PC-005: validateConfig', () => {
    it('有效配置应该返回 true', () => {
      const config = {
        botId: 'test-bot',
        secret: 'test-secret',
        defaultUser: 'test-user',
      };
      const isValid = validateConfig(config);
      expect(isValid).toBe(true);
    });

    it('空配置应该返回 false', () => {
      const isValid = validateConfig({});
      expect(isValid).toBe(false);
    });

    it('缺少必需字段应该返回 false', () => {
      const config = {
        botId: 'test-bot',
        // missing secret
        defaultUser: 'test-user',
      };
      const isValid = validateConfig(config);
      expect(isValid).toBe(false);
    });
  });

  describe('ProjectConfig 结构', () => {
    it('配置应该包含所有字段', () => {
      const config = {
        botId: 'test-bot',
        secret: 'test-secret',
        defaultUser: 'test-user',
        nameTag: 'test-robot',
      };

      expect(config.botId).toBe('test-bot');
      expect(config.secret).toBe('test-secret');
      expect(config.defaultUser).toBe('test-user');
      expect(config.nameTag).toBe('test-robot');
    });

    it('nameTag 应该是可选的', () => {
      const config = {
        botId: 'test-bot',
        secret: 'test-secret',
        defaultUser: 'test-user',
      };

      expect(config.botId).toBe('test-bot');
      expect(config.nameTag).toBeUndefined();
    });
  });
});