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
} from '../connection-manager.js';
import {
  registerCcId,
  unregisterCcId,
  getRobotByCcId,
} from '../http-server.js';
import {
  enterHeadlessMode,
  exitHeadlessMode,
  isHeadlessMode,
} from '../headless-state.js';
import { subscribeWecomMessageByRobot, WecomMessage } from '../message-bus.js';
import { updateWechatModeConfig, addPermissionHook, removePermissionHook, addTaskCompletedHook, removeTaskCompletedHook } from '../project-config.js';
import { logger } from '../logger.js';

// 辅助函数：从 ccId 获取客户端
async function getConnectedClient(ccId: string | undefined): Promise<{ error: string | null; client: Awaited<ReturnType<typeof getClient>>; robotName: string | null }> {
  if (!ccId) {
    return { error: '未在微信模式', client: null, robotName: null };
  }

  const rn = getRobotByCcId(ccId);
  if (!rn) {
    return { error: '未在微信模式', client: null, robotName: null };
  }

  const client = await getClient(rn);
  if (!client) {
    return { error: '未连接机器人，请先进入微信模式', client: null, robotName: null };
  }
  return { error: null, client, robotName: rn };
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
      cc_id: z.string().describe('CC 唯一标识（enter_headless_mode 返回的 ccId）'),
    },
    async ({ content, target_user, cc_id }, extra) => {
      const { error, client } = await getConnectedClient(cc_id);
      if (error || !client) {
        return { content: [{ type: 'text', text: JSON.stringify({ error }) }] };
      }

      // 自动在消息头部添加 ccId 标识（多对一场景区分）
      const prefixedContent = `【${cc_id}】${content}`;
      const success = await client.sendText(prefixedContent, target_user);
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
    '获取待处理的微信消息。支持长轮询：传入 timeout_ms 后阻塞等待，有消息立即返回，无消息等到超时。超时不是停止信号，必须立即重新调用继续轮询。',
    {
      clear: z.boolean().optional().default(true).describe('是否清除已获取的消息'),
      timeout_ms: z.number().optional().default(30000).describe('长轮询超时（毫秒），默认 30000，最大 60000'),
      cc_id: z.string().describe('CC 唯一标识（enter_headless_mode 返回的 ccId）'),
    },
    async ({ clear, timeout_ms = 0, cc_id }) => {
      const { error, client, robotName } = await getConnectedClient(cc_id);

      if (error || !client) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ error: error || '未连接' }),
          }],
        };
      }

      // 消息格式化：返回给智能体的数据结构
      // 字段说明：
      // - content: 用户发送的消息内容
      // - from: 发送者用户 ID
      // - chatid: 会话 ID（单聊=用户ID，群聊=群ID）
      // - chattype: 会话类型（single/group）
      // - time: 消息时间（ISO 格式）
      // - quoteContent: 用户引用的消息内容（可选，用户回复时引用的上一条消息）
      const formatMessages = (msgs: Array<{ content: string; from_userid: string; chatid: string; chattype: 'single' | 'group'; timestamp: number; quoteContent?: string }>) =>
        msgs.map(m => ({
          content: m.content,
          from: m.from_userid,
          chatid: m.chatid,
          chattype: m.chattype,
          time: new Date(m.timestamp).toISOString(),
          quoteContent: m.quoteContent,
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

      // 无积压且不等待，立即返回空（timeout_ms 传 0 时）
      const waitMs = Math.min(timeout_ms, 60000);
      if (waitMs <= 0) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              count: 0,
              messages: [],
              hint: 'timeout_ms=0 仅用于检查积压消息，请传入 timeout_ms=30000 开始长轮询'
            }),
          }],
        };
      }

      // 长轮询：订阅消息总线，等待该机器人的消息
      const arrived = await new Promise<WecomMessage | null>(resolve => {
        const timer = setTimeout(() => {
          sub.unsubscribe();
          resolve(null);
        }, waitMs);

        const sub = subscribeWecomMessageByRobot(robotName!, (msg) => {
          clearTimeout(timer);
          sub.unsubscribe();
          resolve(msg);
        });
      });

      if (arrived === null) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              count: 0,
              messages: [],
              timeout: true,
              hint: '超时不是停止信号，必须立即重新调用 get_pending_messages 继续轮询。不需要 sleep 或等待。'
            }),
          }],
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
    '列出配置中的所有机器人名称。多 CC 可共享同一机器人，直接选择使用即可。',
    {},
    async () => {
      const allRobots = listAllRobots();
      const names = allRobots.map(robot => robot.name);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ robots: names }, null, 2),
        }],
      };
    }
  );

  // ============================================
  // 工具 9: 进入 headless 模式
  // ============================================
  server.tool(
    'enter_headless_mode',
    '进入微信模式，建立 WebSocket 连接。当用户说「现在开始通过微信联系」时调用。',
    {
      cc_id: z.string().describe('CC 唯一标识，由智能体根据项目特征生成，用于识别不同 CC 实例'),
      agent_name: z.string().optional().describe('智能体名称（显示在微信消息中）'),
      robot_id: z.string().optional().describe('指定机器人名称或序号'),
      project_dir: z.string().optional().describe('项目目录路径（用于写入配置文件）'),
      auto_approve: z.boolean().optional().default(true).describe('超时自动审批（默认 true）'),
      auto_approve_timeout: z.number().optional().default(600).describe('自动审批超时时间（秒，默认 600 即 10 分钟）'),
    },
    async ({ cc_id, agent_name, robot_id, project_dir, auto_approve, auto_approve_timeout }, extra) => {
      // 获取项目目录
      const projectDir = project_dir || process.cwd();

      // 智能体名称（可选，未指定时使用 cc_id）
      const effectiveAgentName = agent_name || cc_id;

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

      // 连接机器人
      const result = await connectRobot(selectedRobot.name, effectiveAgentName);

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

      // 注册 ccId 到 CC 注册表（由智能体传入）
      registerCcId(cc_id, selectedRobot.name, effectiveAgentName);

      // 更新项目配置文件中的 wechatMode 为 true
      updateWechatModeConfig(projectDir, {
        wechatMode: true,
        robotName: selectedRobot.name,
        ccId: cc_id,
        autoApprove: auto_approve,
        autoApproveTimeout: auto_approve_timeout,
      });

      // 添加 PermissionRequest hook 到项目 settings.json
      const hookResult = addPermissionHook(projectDir);

      // 添加 TaskCompleted hook 到项目 settings.json
      const taskCompletedHookResult = addTaskCompletedHook(projectDir);

      // 发送确认消息（包含 ccId 标识）
      await result.client.sendText(`【${cc_id}】已进入微信模式，使用机器人「${selectedRobot.name}」。`);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            status: 'entered',
            headless: true,
            robotName: selectedRobot.name,
            ccId: cc_id,
            hook: hookResult,
            taskCompletedHook: taskCompletedHookResult,
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
      cc_id: z.string().describe('CC 唯一标识（enter_headless_mode 返回的 ccId）'),
      project_dir: z.string().optional().describe('项目目录路径（用于更新配置文件）'),
    },
    async ({ cc_id, project_dir }) => {
      const { error, client, robotName } = await getConnectedClient(cc_id);

      if (error || !client || !robotName) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ status: 'error', message: '未在微信模式' }),
          }],
        };
      }

      // 发送退出通知（使用 ccId 作为标识）
      await client.sendText(`【${cc_id}】已退出微信模式，恢复终端交互。`);

      // 注销 ccId
      if (cc_id) {
        unregisterCcId(cc_id);
      }

      // 断开连接
      disconnectRobot(robotName);

      // 更新项目配置文件中的 wechatMode 为 false
      const projectDir = project_dir || process.cwd();
      updateWechatModeConfig(projectDir, { wechatMode: false });

      // 删除 PermissionRequest hook 从项目 settings.json
      const hookResult = removePermissionHook(projectDir);

      // 删除 TaskCompleted hook 从项目 settings.json
      const taskCompletedHookResult = removeTaskCompletedHook(projectDir);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            status: 'exited',
            headless: false,
            robotName,
            hook: hookResult,
            taskCompletedHook: taskCompletedHookResult,
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
    {
      timeout: z.number().optional().describe('超时时间（秒），默认 60'),
      cc_id: z.string().optional().describe('CC 唯一标识（enter_headless_mode 返回的 ccId）'),
    },
    async ({ timeout = 60, cc_id }) => {
      const { error, client } = await getConnectedClient(cc_id);
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

  logger.log('[mcp] 已注册 11 个工具');
}