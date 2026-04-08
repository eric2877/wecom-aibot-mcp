/**
 * cc-registry 单元测试
 *
 * 测试范围：
 * - 注册/注销/续期/占用检测
 * - 文件锁并发安全
 * - 过期清理
 * - 读写持久化
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// 测试用的独立目录
const TEST_DIR = path.join(os.tmpdir(), 'wecom-test-' + Date.now());

import {
  registerCcId,
  unregisterCcId,
  isCcIdRegistered,
  touchCcId,
  getCcIdBinding,
  getRegistry,
  cleanupExpiredEntries,
  setConfigDir,
} from '../../src/cc-registry.js';

describe('cc-registry', () => {
  beforeEach(() => {
    // 创建测试目录
    fs.mkdirSync(TEST_DIR, { recursive: true });
    // 设置测试配置目录
    setConfigDir(TEST_DIR);
    // 清理旧文件
    try { fs.unlinkSync(path.join(TEST_DIR, 'cc-registry.json')); } catch {}
    try { fs.unlinkSync(path.join(TEST_DIR, 'cc-registry.lock')); } catch {}
  });

  afterEach(() => {
    // 清理测试目录
    try {
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
    } catch {}
  });

  describe('registerCcId', () => {
    it('应成功注册新 ccId', () => {
      const result = registerCcId('test-project', 'robot-1');
      expect(result).toBe('registered');

      expect(isCcIdRegistered('test-project')).toBe(true);
      const binding = getCcIdBinding('test-project');
      expect(binding).toEqual({ robotName: 'robot-1' });
    });

    it('应允许相同 ccId + 相同 robotName 续期', () => {
      const result1 = registerCcId('test-project', 'robot-1');
      expect(result1).toBe('registered');

      const result2 = registerCcId('test-project', 'robot-1');
      expect(result2).toBe('renewed');
    });

    it('应拒绝相同 ccId + 不同 robotName', () => {
      const result1 = registerCcId('test-project', 'robot-1');
      expect(result1).toBe('registered');

      const result2 = registerCcId('test-project', 'robot-2');
      expect(result2).toBe('occupied');
    });

    it('应持久化到文件', () => {
      registerCcId('test-project', 'robot-1');

      const fileContent = fs.readFileSync(path.join(TEST_DIR, 'cc-registry.json'), 'utf-8');
      const registry = JSON.parse(fileContent);

      expect(registry['test-project']).toBeDefined();
      expect(registry['test-project'].robotName).toBe('robot-1');
    });
  });

  describe('unregisterCcId', () => {
    it('应成功注销已注册的 ccId', () => {
      registerCcId('test-project', 'robot-1');
      expect(isCcIdRegistered('test-project')).toBe(true);

      unregisterCcId('test-project');
      expect(isCcIdRegistered('test-project')).toBe(false);
    });

    it('注销不存在的 ccId 应安全忽略', () => {
      expect(() => unregisterCcId('nonexistent')).not.toThrow();
    });
  });

  describe('touchCcId', () => {
    it('应更新 lastActive 时间', async () => {
      registerCcId('test-project', 'robot-1');
      const registry1 = getRegistry();
      const time1 = registry1['test-project'].lastActive;

      await new Promise(r => setTimeout(r, 100));
      touchCcId('test-project');

      const registry2 = getRegistry();
      const time2 = registry2['test-project'].lastActive;
      expect(time2).toBeGreaterThan(time1);
    });

    it('touch 不存在的 ccId 应安全忽略', () => {
      expect(() => touchCcId('nonexistent')).not.toThrow();
    });
  });

  describe('getCcIdBinding', () => {
    it('应返回绑定的 robotName', () => {
      registerCcId('test-project', 'robot-1');
      const binding = getCcIdBinding('test-project');
      expect(binding).toEqual({ robotName: 'robot-1' });
    });

    it('未注册的 ccId 应返回 null', () => {
      const binding = getCcIdBinding('nonexistent');
      expect(binding).toBeNull();
    });
  });

  describe('cleanupExpiredEntries', () => {
    it('应清理过期条目（超过 14 天）', () => {
      // 手动创建一个过期的条目
      const expiredTime = Date.now() - 15 * 24 * 60 * 60 * 1000; // 15 天前
      const registry = {
        'expired-project': {
          robotName: 'robot-1',
          lastActive: expiredTime,
          createdAt: expiredTime,
        },
        'active-project': {
          robotName: 'robot-2',
          lastActive: Date.now(),
          createdAt: Date.now(),
        },
      };
      fs.writeFileSync(path.join(TEST_DIR, 'cc-registry.json'), JSON.stringify(registry));

      cleanupExpiredEntries();

      expect(isCcIdRegistered('expired-project')).toBe(false);
      expect(isCcIdRegistered('active-project')).toBe(true);
    });
  });

  describe('并发安全', () => {
    it('文件锁应防止并发写冲突', async () => {
      const results = await Promise.all([
        Promise.resolve().then(() => registerCcId('project-1', 'robot-1')),
        Promise.resolve().then(() => registerCcId('project-2', 'robot-2')),
        Promise.resolve().then(() => registerCcId('project-3', 'robot-3')),
      ]);

      expect(results).toEqual(['registered', 'registered', 'registered']);
      expect(isCcIdRegistered('project-1')).toBe(true);
      expect(isCcIdRegistered('project-2')).toBe(true);
      expect(isCcIdRegistered('project-3')).toBe(true);
    });
  });
});