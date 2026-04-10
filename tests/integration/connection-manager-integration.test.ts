/**
 * 连接管理集成测试
 *
 * 测试真实的连接管理行为
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// 配置目录
const CONFIG_DIR = path.join(os.homedir(), '.wecom-aibot-mcp');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

describe('连接管理集成测试', () => {
  let connectionManager: typeof import('../../src/connection-manager');

  beforeAll(async () => {
    // 确保配置目录存在
    if (!fs.existsSync(CONFIG_DIR)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
    }

    // 写入测试配置
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({
      botId: 'test-bot-id',
      secret: 'test-secret',
      targetUserId: 'test-user'
    }));

    // 导入模块
    connectionManager = await import('../../src/connection-manager.js');
  });

  afterAll(() => {
    // 清理配置
    if (fs.existsSync(CONFIG_FILE)) {
      fs.unlinkSync(CONFIG_FILE);
    }
  });

  describe('CM-INT-001: 连接状态', () => {
    it('无连接时应该返回 disconnected', () => {
      const state = connectionManager.getConnectionState();
      expect(state.connected).toBe(false);
      expect(state.robotName).toBeNull();
      expect(state.connectedAt).toBeNull();
    });

    it('getAllConnectionStates 应该返回数组', () => {
      const states = connectionManager.getAllConnectionStates();
      expect(Array.isArray(states)).toBe(true);
    });
  });

  describe('CM-INT-002: 连接机器人', () => {
    it('连接不存在的机器人应该返回错误', async () => {
      const result = await connectionManager.connectRobot('non-existent-robot', 'TestAgent');
      expect(result.success).toBe(false);
      expect(result.error).toContain('未找到机器人配置');
    });
  });

  describe('CM-INT-003: 获取客户端', () => {
    it('未连接的机器人应该返回 null', async () => {
      const client = await connectionManager.getClient('non-existent-robot');
      expect(client).toBeNull();
    });
  });

  describe('CM-INT-004: 断开连接', () => {
    it('断开不存在的机器人应该无操作', () => {
      // 不应该抛出错误
      connectionManager.disconnectRobot('unknown-robot');
    });
  });

  describe('CM-INT-005: 更新智能体名称', () => {
    it('更新不存在的机器人应该无操作', () => {
      // 不应该抛出错误
      connectionManager.updateAgentName('unknown', 'NewAgent');
    });
  });
});