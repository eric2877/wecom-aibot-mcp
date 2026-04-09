/**
 * MCP 工具注册入口
 *
 * 注册以下工具：
 * - send_message: 发送消息
 * - send_approval_request: 发送审批请求
 * - get_approval_result: 获取审批结果
 * - check_connection: 检查连接状态
 * - get_pending_messages: 获取待处理消息
 * - get_setup_guide: 获取安装指南
 * - add_robot_config: 添加机器人配置
 * - list_robots: 列出所有机器人
 * - get_robot_status: 获取机器人状态
 * - enter_headless_mode: 进入微信模式
 * - exit_headless_mode: 退出微信模式
 * - detect_user_from_message: 从消息识别用户
 *
 * v2.0 架构变更：
 * - 不再使用 projectDir 参数
 * - 从 Session 自动获取 robotName
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { listAllRobots } from '../config-wizard.js';
import {
  connectRobot,
  disconnectRobot,
  getClient,
  getConnectionState,
  isRobotOccupied,
  getRobotOccupiedBy,
} from '../connection-manager.js';
import {
  getSessionDataById,
  setSessionData,
  deleteSession,
  generateCcId,
  findSessionByRobotName,
  registerCcId,
  unregisterCcId,
} from '../http-server.js';
import {
  enterHeadlessMode,
  exitHeadlessMode,
  isHeadlessMode,
} from '../headless-state.js';
import { subscribeWecomMessageByRobot, WecomMessage } from '../message-bus.js';

// 辅助函数：从 session 获取客户端
async function getConnectedClient(sessionId: string | undefined): Promise<{ error: string | null; client: Awaited<ReturnType<typeof getClient>>; sessionData: ReturnType<typeof getSessionDataById> }> {
  const sessionData = getSessionDataById(sessionId);

  if (!sessionData || !sessionData.robotName) {
    return {
      error: '未在微信模式',
      client: null,
      sessionData: null,
    };
  }

  const client = await getClient(sessionData.robotName);
  if (!client) {
    return {
      error: '未连接机器人，请先进入微信模式',
      client: null,
      sessionData: null,
    };
  }
  return { error: null, client, sessionData };
}

export function registerTools(server: McpServer) {
  // ============================================
  // 工具 1: 发送文本消息
  // ============================================
  server.tool(
    'send_message',
    '向企业微信发送消息（用于通知用户）。群聊时传入 chatid 可回复到群里。',
    {
      content: z.string().describe('消息内容（支持 Markdown）'),
      target_user: z.string().optional().describe('目标用户/群 ID（可选）'),
    },
    async ({ content, target_user }, extra) => {
      const { error, client, sessionData } = await getConnectedClient(extra.sessionId);
      if (error || !client) {
        return { content: [{ type: 'text', text: JSON.stringify({ error }) }] };
      }

      // 消息内容直接发送，ccId 已在 enter_headless_mode 时发送过
      const success = await client.sendText(content, target_user);
      return {
        content: [{ type: 'text', text: success ? '消息已发送' : '发送失败，请检查连接状态' }],
      };
    }
  );

  // ============================================
  // 工具 4: 检查连接状态
  // ============================================
  server.tool(
    'check_connection',
    '检查当前 WebSocket 连接状态',
    {},
    async () => {
      const state = getConnectionState();
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            connected: state.connected,
            robotName: state.robotName,
            connectedAt: state.connectedAt,
          }),
        }],
      };
    }
  );

  // ============================================
  // 工具 6: 获取待处理消息
  // ============================================
  server.tool(
    'get_pending_messages',
    '获取待处理的微信消息。支持长轮询：传入 timeout_ms 后阻塞等待，有消息立即返回，无消息等到超时。',
    {
      clear: z.boolean().optional().default(true).describe('是否清除已获取的消息'),
      timeout_ms: z.number().optional().default(0).describe('长轮询超时（毫秒），0 表示立即返回，最大 60000'),
    },
    async ({ clear, timeout_ms = 0 }, extra) => {
      const { error, client, sessionData } = await getConnectedClient(extra.sessionId);

      if (error || !client) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ error: error || '未连接' }),
          }],
        };
      }

      const formatMessages = (msgs: Array<{ content: string; from_userid: string; chatid: string; chattype: 'single' | 'group'; timestamp: number }>) =>
        msgs.map(m => ({
          content: m.content,
          from: m.from_userid,
          chatid: m.chatid,
          chattype: m.chattype,
          time: new Date(m.timestamp).toISOString(),
        }));

      // 先检查是否已有积压消息
      const existing = client.getPendingMessages(false);
      if (existing.length > 0) {
        if (clear) client.getPendingMessages(true);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ count: existing.length, messages: formatMessages(existing) }, null, 2),
          }],
        };
      }

      // 无积压且不等待，立即返回空
      const waitMs = Math.min(timeout_ms, 60000);
      if (waitMs <= 0) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ count: 0, messages: [] }) }],
        };
      }

      // 长轮询：订阅消息总线，等待该机器人的消息
      const robotName = sessionData!.robotName;
      const arrived = await new Promise<WecomMessage | null>(resolve => {
        const timer = setTimeout(() => {
          sub.unsubscribe();
          resolve(null);
        }, waitMs);

        const sub = subscribeWecomMessageByRobot(robotName, (msg) => {
          clearTimeout(timer);
          sub.unsubscribe();
          resolve(msg);
        });
      });

      if (arrived === null) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ count: 0, messages: [], timeout: true }) }],
        };
      }

      // 消息到了，取出所有积压（含刚到的）
      const messages = client.getPendingMessages(clear);
      const result = messages.length > 0 ? messages : [arrived];
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ count: result.length, messages: formatMessages(result) }, null, 2),
        }],
      };
    }
  );

  // ============================================
  // 工具 7: 获取安装配置指南
  // ============================================
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

## 可用工具
- \`send_message\` - 发送消息
- \`send_approval_request\` - 发送审批请求
- \`get_approval_result\` - 获取审批结果
- \`check_connection\` - 检查连接状态
- \`list_robots\` - 列出所有机器人
- \`enter_headless_mode\` - 进入微信模式
- \`exit_headless_mode\` - 退出微信模式

## 用户消息接收
进入微信模式后，用户消息通过 SSE 实时推送，无需轮询。
`;
      return { content: [{ type: 'text', text: guide }] };
    }
  );

  // ============================================
  // 工具 7: 添加新机器人配置
  // ============================================
  server.tool(
    'add_robot_config',
    '添加新机器人配置',
    {
      name: z.string().describe('机器人名称'),
      bot_id: z.string().describe('企业微信 Bot ID'),
      secret: z.string().describe('机器人密钥'),
      default_user: z.string().optional().describe('默认目标用户'),
    },
    async ({ name, bot_id, secret, default_user }) => {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            message: '请使用 --add 命令添加机器人配置',
            command: `npx @vrs-soft/wecom-aibot-mcp --add`,
          }, null, 2),
        }],
      };
    }
  );

  // ============================================
  // 工具 8: 列出所有机器人
  // ============================================
  server.tool(
    'list_robots',
    '列出配置中的所有机器人及其状态',
    {},
    async () => {
      const allRobots = listAllRobots();
      const state = getConnectionState();

      const robots = allRobots.map(robot => {
        const occupied = isRobotOccupied(robot.name);
        const occupiedBy = occupied ? getRobotOccupiedBy(robot.name) : null;
        const connected = state.robotName === robot.name && state.connected;

        return {
          name: robot.name,
          botId: robot.botId,
          targetUser: robot.targetUserId,
          status: connected ? 'connected' : (occupied ? 'occupied' : 'available'),
          occupiedBy,
        };
      });

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            robots,
            total: robots.length,
            connected: robots.filter(r => r.status === 'connected').length,
            occupied: robots.filter(r => r.status === 'occupied').length,
          }, null, 2),
        }],
      };
    }
  );

  // ============================================
  // 工具 10: 进入 headless 模式
  // ============================================
  server.tool(
    'enter_headless_mode',
    '进入微信模式，建立 WebSocket 连接。当用户说「现在开始通过微信联系」时调用。',
    {
      agent_name: z.string().describe('智能体名称'),
      robot_id: z.string().optional().describe('指定机器人名称或序号'),
    },
    async ({ agent_name, robot_id }, extra) => {
      const allRobots = listAllRobots();

      if (allRobots.length === 0) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              status: 'error',
              message: '请先配置机器人: npx @vrs-soft/wecom-aibot-mcp --config',
            }),
          }],
        };
      }

      // 多机器人选择
      if (allRobots.length > 1 && !robot_id) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              status: 'select_robot',
              message: '检测到多个机器人配置，请选择要使用的机器人',
              robots: allRobots.map((r, i) => ({
                index: i + 1,
                name: r.name,
              })),
              hint: '请调用 enter_headless_mode 并传入 robot_id 参数',
            }, null, 2),
          }],
        };
      }

      // 选择机器人
      let selectedRobot = allRobots[0];

      if (robot_id) {
        const index = parseInt(robot_id);
        if (!isNaN(index) && index >= 1 && index <= allRobots.length) {
          selectedRobot = allRobots[index - 1];
        } else {
          selectedRobot = allRobots.find(r =>
            r.name === robot_id || r.botId === robot_id || r.name.includes(robot_id)
          ) || selectedRobot;
        }
      }

      // 检查机器人是否被占用（检查是否有 headless session 绑定）
      const existingSessionId = findSessionByRobotName(selectedRobot.name);
      if (existingSessionId) {
        const sessionData = getSessionDataById(existingSessionId);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              status: 'error',
              errorType: 'robot_occupied',
              message: `机器人「${selectedRobot.name}」已被占用`,
              occupiedBy: sessionData?.agentName,
              hint: '请选择其他机器人，或让占用者退出微信模式',
              availableRobots: allRobots.filter(r => !findSessionByRobotName(r.name)).map(r => r.name),
            }, null, 2),
          }],
        };
      }

      // 连接机器人
      const result = await connectRobot(selectedRobot.name, agent_name);

      if (!result.success || !result.client) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              status: 'error',
              message: result.error || '连接失败',
            }),
          }],
        };
      }

      // 生成 ccId
      const ccId = generateCcId();

      // 存储到 Session
      if (extra.sessionId) {
        setSessionData(extra.sessionId, {
          robotName: selectedRobot.name,
          agentName: agent_name,
          ccId,
          createdAt: Date.now(),
        });
      }

      // MCP 注册 ccId → robotName 映射（不依赖 session 生命周期）
      registerCcId(ccId, selectedRobot.name);

      // 发送确认消息（包含 ccId 标识）
      await result.client.sendText(`【${ccId}】已进入微信模式，使用机器人「${selectedRobot.name}」。`);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            status: 'entered',
            headless: true,
            robotName: selectedRobot.name,
            ccId,
            message: '用户消息通过 SSE 实时推送，审批请求通过微信发送',
          }),
        }],
      };
    }
  );

  // ============================================
  // 工具 11: 退出 headless 模式
  // ============================================
  server.tool(
    'exit_headless_mode',
    '退出微信模式，断开连接。当用户说「结束微信模式」或「我回来了」时调用。',
    {
      agent_name: z.string().optional().describe('智能体名称'),
    },
    async ({ agent_name }, extra) => {
      const sessionData = getSessionDataById(extra.sessionId);

      if (!sessionData || !sessionData.robotName) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ status: 'error', message: '未在微信模式' }),
          }],
        };
      }

      const robotName = sessionData.robotName;
      const client = await getClient(robotName);

      // 发送退出通知
      if (client) {
        const name = agent_name || sessionData.agentName || '智能体';
        await client.sendText(`【${name}】已退出微信模式，恢复终端交互。`);
      }

      // 注销 ccId → robotName 映射
      if (sessionData.ccId) {
        unregisterCcId(sessionData.ccId);
      }

      // 断开连接
      disconnectRobot(robotName);

      // 删除 Session
      if (extra.sessionId) {
        deleteSession(extra.sessionId);
      }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            status: 'exited',
            headless: false,
            robotName,
            message: '审批将使用默认 UI',
          }),
        }],
      };
    }
  );

  // ============================================
  // 工具 12: 从消息识别用户
  // ============================================
  server.tool(
    'detect_user_from_message',
    '等待用户发送消息并返回用户 ID。',
    { timeout: z.number().optional().describe('超时时间（秒），默认 60') },
    async ({ timeout = 60 }, extra) => {
      const { error, client } = await getConnectedClient(extra.sessionId);
      if (error || !client) {
        return { content: [{ type: 'text', text: JSON.stringify({ error }) }] };
      }

      const timeoutMs = timeout * 1000;
      const startTime = Date.now();

      while (Date.now() - startTime < timeoutMs) {
        const messages = client.getPendingMessages(false);
        if (messages.length > 0) {
          const msg = messages[0];
          client.getPendingMessages(true);
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                userId: msg.from_userid,
                chatId: msg.chatid,
                message: msg.content,
              }, null, 2),
            }],
          };
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
      }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            error: 'timeout',
            message: `等待超时（${timeout}秒）`,
          }),
        }],
      };
    }
  );

  // ============================================
  // 工具 13: 获取连接状态统计
  // ============================================
  server.tool(
    'get_connection_stats',
    '获取连接状态统计和日志',
    { recent_logs: z.number().optional().describe('最近 N 条日志') },
    async ({ recent_logs = 20 }) => {
      const { getStats, getRecentLogs, getLogFilePath, getStatsFilePath } = await import('../connection-log.js');
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

  console.log('[mcp] 已注册 11 个工具');
}