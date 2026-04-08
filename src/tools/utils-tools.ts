/**
 * 实用工具
 * - list_robots
 * - check_connection
 * - get_setup_guide
 * - add_robot_config
 * - get_connection_stats
 * - detect_user_from_message
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { listAllRobots } from '../config-wizard.js';
import { getClient, getAllConnectionStates, getConnectionState, isRobotOccupied } from '../connection-manager.js';
import { getCcIdBinding, isCcIdRegistered } from '../cc-registry.js';
import { getStats, getRecentLogs, getLogFilePath, getStatsFilePath } from '../connection-log.js';
import { subscribeWecomMessageByRobot } from '../message-bus.js';

const CONFIG_DIR = path.join(os.homedir(), '.wecom-aibot-mcp');

export function registerUtilsTools(server: McpServer): void {
  // ────────────────────────────────────────────
  // list_robots
  // ────────────────────────────────────────────
  server.tool(
    'list_robots',
    '列出所有配置的机器人及其连接状态',
    {},
    async () => {
      const robots = listAllRobots();
      const states = getAllConnectionStates();
      const stateMap = new Map(states.map(s => [s.robotName, s]));

      const result = robots.map(r => {
        const state = stateMap.get(r.name);
        const occupied = isRobotOccupied(r.name);
        return {
          name: r.name,
          botId: r.botId,
          targetUser: r.targetUserId,
          status: state?.connected ? 'connected' : (occupied ? 'bound' : 'available'),
        };
      });

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            robots: result,
            total: result.length,
            connected: result.filter(r => r.status === 'connected').length,
            bound: result.filter(r => r.status === 'bound').length,
          }, null, 2),
        }],
      };
    }
  );

  // ────────────────────────────────────────────
  // check_connection
  // ────────────────────────────────────────────
  server.tool(
    'check_connection',
    '检查当前机器人连接状态',
    {},
    async () => {
      const state = getConnectionState();
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            connected: state.connected,
            robotName: state.robotName,
            ccId: null,  // ccId 由工具调用方持有
            connectedAt: state.connectedAt,
          }, null, 2),
        }],
      };
    }
  );

  // ────────────────────────────────────────────
  // get_setup_guide
  // ────────────────────────────────────────────
  server.tool(
    'get_setup_guide',
    '获取企业微信 MCP 服务安装配置指南',
    {},
    async () => {
      const guide = `# 企业微信智能机器人 MCP 服务 - 安装配置指南

## 安装

\`\`\`bash
npx @vrs-soft/wecom-aibot-mcp
\`\`\`

## MCP 配置

编辑 \`~/.claude.json\`：
\`\`\`json
{
  "mcpServers": {
    "wecom-aibot": {
      "type": "http",
      "url": "http://127.0.0.1:18963/mcp"
    }
  }
}
\`\`\`

## 添加机器人

\`\`\`bash
npx @vrs-soft/wecom-aibot-mcp --add
\`\`\`

## 可用工具

| 工具 | 功能 |
|------|------|
| enter_headless_mode | 进入微信模式 |
| exit_headless_mode  | 退出微信模式 |
| send_message        | 发送消息 |
| get_pending_messages| 长轮询获取消息 |
| list_robots         | 列出机器人 |
| check_connection    | 检查连接 |
| add_robot_config    | 添加机器人配置 |
`;
      return { content: [{ type: 'text', text: guide }] };
    }
  );

  // ────────────────────────────────────────────
  // add_robot_config
  // ────────────────────────────────────────────
  server.tool(
    'add_robot_config',
    '添加新机器人配置（写入 ~/.wecom-aibot-mcp/robot-{name}.json，重启 MCP Server 后生效）',
    {
      name: z.string().describe('机器人名称（字母/数字/中文）'),
      bot_id: z.string().describe('企业微信 Bot ID'),
      secret: z.string().describe('机器人密钥'),
      default_user: z.string().optional().describe('默认推送目标用户 ID（可选）'),
    },
    async ({ name, bot_id, secret, default_user }) => {
      const configFile = path.join(CONFIG_DIR, `robot-${name}.json`);

      if (fs.existsSync(configFile)) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: false,
              error: 'name_exists',
              message: `机器人名称「${name}」已存在，请换一个名称或先删除已有配置`,
            }),
          }],
        };
      }

      const config = {
        nameTag: name,
        botId: bot_id,
        secret,
        targetUserId: default_user || '',
      };

      try {
        fs.mkdirSync(CONFIG_DIR, { recursive: true });
        fs.writeFileSync(configFile, JSON.stringify(config, null, 2), 'utf-8');
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: true,
              message: `机器人配置已写入 ${configFile}，重启 MCP Server 后生效`,
            }),
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ success: false, error: (err as Error).message }),
          }],
        };
      }
    }
  );

  // ────────────────────────────────────────────
  // get_connection_stats
  // ────────────────────────────────────────────
  server.tool(
    'get_connection_stats',
    '获取连接状态统计和最近日志',
    {
      recent_logs: z.number().optional().describe('最近 N 条日志（默认 20）'),
    },
    async ({ recent_logs = 20 }) => {
      const stats = getStats();
      const logs = getRecentLogs(recent_logs);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            stats,
            recentLogs: logs,
            logFile: getLogFilePath(),
            statsFile: getStatsFilePath(),
          }, null, 2),
        }],
      };
    }
  );

  // ────────────────────────────────────────────
  // detect_user_from_message
  // ────────────────────────────────────────────
  server.tool(
    'detect_user_from_message',
    '等待用户发送消息并返回用户 ID（阻塞直到收到消息或超时）',
    {
      ccId: z.string().describe('CC 身份标识'),
      timeout: z.number().optional().describe('超时时间（秒），默认 60'),
    },
    async ({ ccId, timeout = 60 }) => {
      if (!isCcIdRegistered(ccId)) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: '请先调用 enter_headless_mode' }) }]
        };
      }

      const binding = getCcIdBinding(ccId);
      if (!binding) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: '请先调用 enter_headless_mode' }) }]
        };
      }

      const client = await getClient(binding.robotName);
      if (!client) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: '机器人未连接' }) }]
        };
      }

      // 先检查已缓存消息
      const cached = client.getPendingMessages(false);
      if (cached.length > 0) {
        const msg = cached[0];
        client.getPendingMessages(true);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ userId: msg.from_userid, chatId: msg.chatid, message: msg.content }),
          }],
        };
      }

      // 长轮询等待
      const timeoutMs = timeout * 1000;
      const result = await new Promise<{ userId: string; chatId: string; message: string } | null>((resolve) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (!settled) { settled = true; sub.unsubscribe(); resolve(null); }
        }, timeoutMs);

        const sub = subscribeWecomMessageByRobot(binding.robotName, (msg) => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            sub.unsubscribe();
            resolve({ userId: msg.from_userid, chatId: msg.chatid, message: msg.content });
          }
        });
      });

      if (!result) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ error: 'timeout', message: `等待超时（${timeout}秒）` }),
          }],
        };
      }

      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );
}
