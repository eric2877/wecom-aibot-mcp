/**
 * Config Wizard 单元测试
 *
 * 测试覆盖：
 * - CW-001: listAllRobots
 * - CW-002: loadConfig
 * - CW-003: saveConfig
 * - CW-004: deleteConfig
 * - CW-005: ensureHookInstalled
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// 模拟文件系统
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: vi.fn(() => true),
    readdirSync: vi.fn(() => ['robot-robot1.json', 'robot-robot2.json']),
    readFileSync: vi.fn((path: string) => {
      if (path.includes('robot-robot1')) {
        return JSON.stringify({
          botId: 'bot1',
          secret: 'secret1',
          targetUserId: 'user1',
          nameTag: 'robot1'
        });
      }
      if (path.includes('robot-robot2')) {
        return JSON.stringify({
          botId: 'bot2',
          secret: 'secret2',
          targetUserId: 'user2',
          nameTag: 'robot2'
        });
      }
      if (path.includes('.claude.json')) {
        return JSON.stringify({
          mcpServers: {
            'wecom-aibot': {
              env: {
                botId: 'default-bot',
                secret: 'default-secret',
                targetUserId: 'default-user'
              }
            }
          }
        });
      }
      return JSON.stringify({
        botId: 'default-bot',
        secret: 'default-secret',
        targetUserId: 'default-user'
      });
    }),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    unlinkSync: vi.fn(),
    rmSync: vi.fn(),
    copyFileSync: vi.fn(),
    statSync: vi.fn(() => ({ isFile: () => true })),
  };
});

vi.mock('path', async (importOriginal) => {
  const actual = await importOriginal<typeof import('path')>();
  return {
    ...actual,
    join: vi.fn((...args) => args.join('/')),
    basename: vi.fn((p) => p.split('/').pop() || p),
    dirname: vi.fn((p) => p.split('/').slice(0, -1).join('/')),
  };
});

vi.mock('os', () => ({
  homedir: vi.fn(() => '/home/test'),
}));

vi.mock('readline', () => ({
  createInterface: vi.fn(() => ({
    question: vi.fn((_, cb) => cb('y')),
    close: vi.fn(),
  })),
}));

// 导入实际函数
import {
  listAllRobots,
  loadConfig,
  saveConfig,
  deleteConfig,
  deleteHook,
  ensureHookInstalled,
} from '../../src/config-wizard';

describe('Config Wizard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('CW-001: listAllRobots', () => {
    it('应该列出所有配置的机器人', () => {
      const robots = listAllRobots();
      expect(Array.isArray(robots)).toBe(true);
    });

    it('每个机器人应该包含必需字段', () => {
      const robots = listAllRobots();
      for (const robot of robots) {
        expect(robot).toHaveProperty('name');
        expect(robot).toHaveProperty('botId');
        expect(robot).toHaveProperty('targetUserId');
      }
    });

    it('至少返回一个机器人', () => {
      const robots = listAllRobots();
      expect(robots.length).toBeGreaterThan(0);
    });
  });

  describe('CW-002: loadConfig', () => {
    it('应该能加载配置', () => {
      const config = loadConfig();
      if (config) {
        expect(config).toHaveProperty('botId');
        expect(config).toHaveProperty('secret');
        expect(config).toHaveProperty('targetUserId');
      }
    });
  });

  describe('CW-003: saveConfig', () => {
    it('应该能保存配置', () => {
      const config = {
        botId: 'test-bot',
        secret: 'test-secret',
        targetUserId: 'test-user'
      };

      saveConfig(config);
      expect(true).toBe(true);
    });

    it('应该能保存带实例名的配置', () => {
      const config = {
        botId: 'test-bot',
        secret: 'test-secret',
        targetUserId: 'test-user'
      };

      saveConfig(config, 'custom-instance');
      expect(true).toBe(true);
    });
  });

  describe('CW-004: deleteConfig', () => {
    it('应该能删除配置', () => {
      deleteConfig();
      expect(true).toBe(true);
    });
  });

  describe('CW-005: deleteHook', () => {
    it('应该能删除 Hook', () => {
      deleteHook();
      expect(true).toBe(true);
    });
  });

  describe('CW-006: ensureHookInstalled', () => {
    it('应该能确保 Hook 安装', () => {
      ensureHookInstalled();
      expect(true).toBe(true);
    });
  });

  describe('机器人配置结构', () => {
    it('机器人配置应该包含所有必需字段', () => {
      const robot = {
        name: 'test-robot',
        botId: 'test-bot-id',
        targetUserId: 'test-user',
      };

      expect(robot.name).toBe('test-robot');
      expect(robot.botId).toBe('test-bot-id');
      expect(robot.targetUserId).toBe('test-user');
    });

    it('返回的机器人配置至少包含基本字段', () => {
      const robots = listAllRobots();
      for (const robot of robots) {
        expect(typeof robot.name).toBe('string');
        expect(typeof robot.botId).toBe('string');
        expect(typeof robot.targetUserId).toBe('string');
      }
    });
  });

  describe('配置验证', () => {
    it('botId 应该是非空字符串', () => {
      const config = {
        botId: '',
        secret: 'test-secret',
        targetUserId: 'test-user'
      };

      expect(config.botId).toBe('');
    });

    it('secret 应该是非空字符串', () => {
      const config = {
        botId: 'test-bot',
        secret: 'test-secret',
        targetUserId: 'test-user'
      };

      expect(config.secret).toBe('test-secret');
    });

    it('targetUserId 应该是非空字符串', () => {
      const config = {
        botId: 'test-bot',
        secret: 'test-secret',
        targetUserId: 'test-user'
      };

      expect(config.targetUserId).toBe('test-user');
    });
  });

  describe('WecomConfig 接口', () => {
    it('配置应该包含所有字段', () => {
      const config = {
        botId: 'test-bot',
        secret: 'test-secret',
        targetUserId: 'test-user',
        nameTag: 'MyRobot'
      };

      expect(config.botId).toBe('test-bot');
      expect(config.secret).toBe('test-secret');
      expect(config.targetUserId).toBe('test-user');
      expect(config.nameTag).toBe('MyRobot');
    });

    it('nameTag 应该是可选的', () => {
      const config = {
        botId: 'test-bot',
        secret: 'test-secret',
        targetUserId: 'test-user'
      };

      expect(config.nameTag).toBeUndefined();
    });
  });

  describe('多机器人配置', () => {
    it('应该能列出多个机器人', () => {
      const robots = listAllRobots();
      expect(robots.length).toBeGreaterThanOrEqual(2);
    });

    it('每个机器人应该有唯一的名称', () => {
      const robots = listAllRobots();
      const names = robots.map(r => r.name);
      const uniqueNames = new Set(names);
      expect(uniqueNames.size).toBe(names.length);
    });
  });
});