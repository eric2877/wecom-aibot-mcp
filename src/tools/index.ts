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
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  enterHeadlessMode,
  exitHeadlessMode,
  loadHeadlessState,
  getAllHeadlessStates,
  setAutoApprove,
} from '../headless-state.js';
import { listAllRobots } from '../config-wizard.js';
import {
  connectRobot,
  disconnectRobot,
  getClient,
  isConnected,
  getConnectionState,
  isRobotOccupied,
  getRobotOccupiedBy,
} from '../connection-manager.js';

// 辅助函数：获取客户端或返回错误
async function getConnectedClient(projectDir?: string) {
  const dir = projectDir || process.cwd();
  const state = loadHeadlessState(dir);
  if (!state) {
    return {
      error: '未在微信模式',
      client: null,
      projectDir: null,
    };
  }
  const client = await getClient(state.projectDir);
  if (!client) {
    return {
      error: '未连接机器人，请先进入微信模式',
      client: null,
      projectDir: state.projectDir,
    };
  }
  return { error: null, client, projectDir: state.projectDir };
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
      agent_name: z.string().optional().describe('智能体名称（可选，自动添加名签）'),
      target_user: z.string().optional().describe('目标用户/群 ID（可选）'),
    },
    async ({ content, agent_name, target_user }) => {
      const { error, client } = await getConnectedClient();
      if (error || !client) {
        return { content: [{ type: 'text', text: JSON.stringify({ error }) }] };
      }

      let finalContent = content;
      if (agent_name) {
        const state = loadHeadlessState();
        const nameTag = state?.agentName || agent_name;
        finalContent = `【${nameTag}】${content}`;
      }

      const success = await client.sendText(finalContent, target_user);
      return {
        content: [{ type: 'text', text: success ? '消息已发送' : '发送失败，请检查连接状态' }],
      };
    }
  );

  // ============================================
  // 工具 2: 发送审批请求
  // ============================================
  server.tool(
    'send_approval_request',
    '发送审批请求到企业微信（带按钮的模板卡片）',
    {
      title: z.string().describe('审批标题'),
      description: z.string().describe('审批描述（操作详情）'),
      request_id: z.string().describe('请求 ID'),
      agent_name: z.string().optional().describe('智能体名称（可选）'),
      target_user: z.string().optional().describe('目标用户 ID（可选）'),
    },
    async ({ title, description, request_id, agent_name, target_user }) => {
      const { error, client } = await getConnectedClient();
      if (error || !client) {
        return { content: [{ type: 'text', text: JSON.stringify({ error }) }] };
      }

      let finalTitle = title;
      if (agent_name) {
        const state = loadHeadlessState();
        const nameTag = state?.agentName || agent_name;
        finalTitle = `【${nameTag}】${title}`;
      }

      try {
        const taskId = await client.sendApprovalRequest(finalTitle, description, request_id, target_user);
        return { content: [{ type: 'text', text: JSON.stringify({ taskId, status: 'pending' }) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: (err as Error).message }) }] };
      }
    }
  );

  // ============================================
  // 工具 3: 获取审批结果
  // ============================================
  server.tool(
    'get_approval_result',
    '查询审批任务当前状态（非阻塞，立即返回）。',
    { task_id: z.string().describe('审批任务 ID') },
    async ({ task_id }) => {
      const { error, client } = await getConnectedClient();
      if (error || !client) {
        return { content: [{ type: 'text', text: JSON.stringify({ error }) }] };
      }

      const result = client.getApprovalResult(task_id);
      return { content: [{ type: 'text', text: JSON.stringify({ taskId: task_id, status: result }) }] };
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
  // 工具 5: 获取待处理消息
  // ============================================
  server.tool(
    'get_pending_messages',
    '获取用户主动发送的待处理消息（非阻塞）。建议轮询间隔 5 秒。',
    { clear: z.boolean().optional().default(true).describe('获取后是否清空队列') },
    async ({ clear }) => {
      const { error, client } = await getConnectedClient();
      if (error || !client) {
        return { content: [{ type: 'text', text: JSON.stringify({ error, messages: [] }) }] };
      }

      const messages = client.getPendingMessages(clear);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            count: messages.length,
            messages: messages.map(m => ({
              content: m.content,
              from: m.from_userid,
              chatid: m.chatid,
              chattype: m.chattype,
              time: new Date(m.timestamp).toISOString(),
            })),
          }, null, 2),
        }],
      };
    }
  );

  // ============================================
  // 工具 6: 获取安装配置指南
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
- \`get_pending_messages\` - 获取用户消息
- \`list_robots\` - 列出所有机器人
- \`enter_headless_mode\` - 进入微信模式
- \`exit_headless_mode\` - 退出微信模式
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
          isDefault: robot.isDefault,
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
  // 工具 9: 获取机器人状态
  // ============================================
  server.tool(
    'get_robot_status',
    '检查指定机器人的详细状态',
    { robot_id: z.string().optional().describe('机器人名称或 ID') },
    async ({ robot_id }) => {
      const allRobots = listAllRobots();
      const state = getConnectionState();

      const robot = robot_id
        ? allRobots.find(r => r.name === robot_id || r.botId === robot_id || r.name.includes(robot_id))
        : allRobots.find(r => r.isDefault);

      if (!robot) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              robotId: robot_id || 'default',
              status: 'not_configured',
              availableRobots: allRobots.map(r => r.name),
            }, null, 2),
          }],
        };
      }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            robotId: robot.name,
            botId: robot.botId,
            targetUser: robot.targetUserId,
            isDefault: robot.isDefault,
            status: state.robotName === robot.name && state.connected ? 'connected' : 'disconnected',
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
      project_dir: z.string().optional().describe('项目目录路径'),
      robot_id: z.string().optional().describe('指定机器人名称或序号'),
    },
    async ({ agent_name, project_dir, robot_id }) => {
      const dir = project_dir || process.cwd();
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
                isDefault: r.isDefault,
              })),
              hint: '请调用 enter_headless_mode 并传入 robot_id 参数',
            }, null, 2),
          }],
        };
      }

      // 选择机器人
      let selectedRobot = allRobots.find(r => r.isDefault) || allRobots[0];

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

      // 检查机器人是否被占用
      if (isRobotOccupied(selectedRobot.name, dir)) {
        const occupiedBy = getRobotOccupiedBy(selectedRobot.name);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              status: 'error',
              errorType: 'robot_occupied',
              message: `机器人「${selectedRobot.name}」已被占用`,
              occupiedBy,
              hint: '请选择其他机器人，或让占用者退出微信模式',
              availableRobots: allRobots.filter(r => !isRobotOccupied(r.name)).map(r => ({
                name: r.name,
                isDefault: r.isDefault,
              })),
            }, null, 2),
          }],
        };
      }

      // 连接机器人
      const result = await connectRobot(dir, selectedRobot.name);

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

      // 进入 headless 模式（记录机器人名称）
      enterHeadlessMode(dir, agent_name, selectedRobot.name);

      // 发送确认消息
      await result.client.sendText(`【${agent_name}】已进入微信模式，使用机器人「${selectedRobot.name}」。`);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            status: 'entered',
            headless: true,
            projectDir: dir,
            robotName: selectedRobot.name,
            message: '审批请求将通过微信发送',
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
      project_dir: z.string().optional().describe('项目目录路径（可选，默认当前目录）'),
    },
    async ({ agent_name, project_dir }) => {
      const dir = project_dir || process.cwd();
      const state = exitHeadlessMode(dir);

      if (!state) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ status: 'error', message: '未在微信模式' }),
          }],
        };
      }

      // 发送退出通知
      const client = await getClient(state.projectDir);
      if (client) {
        const name = agent_name || state.agentName || '智能体';
        await client.sendText(`【${name}】已退出微信模式，恢复终端交互。`);
      }

      // 断开连接
      disconnectRobot(state.projectDir);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            status: 'exited',
            headless: false,
            projectDir: state.projectDir,
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
    async ({ timeout = 60 }) => {
      const { error, client } = await getConnectedClient();
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
  // 工具 13: 设置自动审批
  // ============================================
  server.tool(
    'set_auto_approve',
    '设置超时自动审批开关。',
    {
      enabled: z.boolean().describe('是否启用'),
      project_dir: z.string().optional().describe('项目目录路径（可选，默认当前目录）'),
    },
    async ({ enabled, project_dir }) => {
      const dir = project_dir || process.cwd();
      const state = loadHeadlessState(dir);

      if (!state) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ status: 'error', message: '未在微信模式' }),
          }],
        };
      }

      setAutoApprove(enabled, dir);

      const client = await getClient(state.projectDir);
      if (client) {
        const statusText = enabled ? '已开启' : '已关闭';
        await client.sendText(`【系统】自动审批${statusText}`);
      }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            status: 'success',
            autoApprove: enabled,
            projectDir: state.projectDir,
          }),
        }],
      };
    }
  );

  // ============================================
  // 工具 14: 获取连接状态统计
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

  console.log('[mcp] 已注册 14 个工具');
}