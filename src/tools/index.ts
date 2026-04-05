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
import type { WecomClient } from '../client.js';
import { getStats, getClient } from '../client-pool.js';
import {
  enterHeadlessMode,
  exitHeadlessMode,
  loadHeadlessState,
  isHeadlessMode,
  getAllHeadlessStates,
  setAutoApprove,
} from '../headless-state.js';
import { getConfig, getConfigSource, hasProjectConfig } from '../project-config.js';

export function registerTools(server: McpServer, client: WecomClient) {
  // ============================================
  // 工具 1: 发送文本消息
  // ============================================
  server.tool(
    'send_message',
    '向企业微信发送消息（用于通知用户）。群聊时传入 chatid 可回复到群里。',
    {
      content: z.string().describe('消息内容（支持 Markdown）'),
      agent_name: z.string().optional().describe('智能体名称（可选，自动添加名签）'),
      target_user: z.string().optional().describe('目标用户/群 ID（可选）。群聊时使用 get_pending_messages 返回的 chatid'),
    },
    async ({ content, agent_name, target_user }) => {
      // 添加名签
      let finalContent = content;
      if (agent_name) {
        const state = loadHeadlessState();
        const nameTag = state?.agentName || agent_name;
        finalContent = `【${nameTag}】${content}`;
      }

      const success = await client.sendText(finalContent, target_user);
      return {
        content: [
          {
            type: 'text',
            text: success ? '消息已发送' : '发送失败，请检查连接状态',
          },
        ],
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
      agent_name: z.string().optional().describe('智能体名称（可选，自动添加名签）'),
      target_user: z.string().optional().describe('目标用户 ID（可选）'),
    },
    async ({ title, description, request_id, agent_name, target_user }) => {
      try {
        // 添加名签到标题
        let finalTitle = title;
        if (agent_name) {
          const state = loadHeadlessState();
          const nameTag = state?.agentName || agent_name;
          finalTitle = `【${nameTag}】${title}`;
        }

        const taskId = await client.sendApprovalRequest(finalTitle, description, request_id, target_user);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ taskId, status: 'pending' }),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: (err as Error).message }),
            },
          ],
        };
      }
    }
  );

  // ============================================
  // 工具 3: 获取审批结果（非阻塞）
  // ============================================
  server.tool(
    'get_approval_result',
    '查询审批任务当前状态（非阻塞，立即返回）。',
    {
      task_id: z.string().describe('审批任务 ID'),
    },
    async ({ task_id }) => {
      const result = client.getApprovalResult(task_id);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ taskId: task_id, status: result }),
          },
        ],
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
      const connected = client.isConnected();
      const defaultUser = client.getDefaultTargetUser();
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ connected, defaultTargetUser: defaultUser }),
          },
        ],
      };
    }
  );

  // ============================================
  // 工具 5: 获取待处理消息（非阻塞）
  // ============================================
  server.tool(
    'get_pending_messages',
    '获取用户主动发送的待处理消息（非阻塞）。建议轮询间隔 5 秒。',
    {
      clear: z.boolean().optional().default(true).describe('获取后是否清空队列（默认 true）'),
    },
    async ({ clear }) => {
      const messages = client.getPendingMessages(clear);
      const result = {
        count: messages.length,
        messages: messages.map(m => ({
          content: m.content,
          from: m.from_userid,
          chatid: m.chatid,
          chattype: m.chattype,
          time: new Date(m.timestamp).toISOString(),
        })),
        hint: messages.length > 0
          ? '以上是用户主动发送的消息，群聊消息回复时会发到群里'
          : '暂无待处理消息',
      };
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
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
      const guide = `
# 企业微信智能机器人 MCP 服务 - 安装配置指南

## 安装

\`\`\`bash
npx @vrs-soft/wecom-aibot-mcp
\`\`\`

## MCP 配置（HTTP Transport）

编辑 \`~/.claude.json\`：

\`\`\`json
{
  "mcpServers": {
    "wecom-aibot": {
      "url": "http://127.0.0.1:18963/mcp"
    }
  }
}
\`\`\`

## 配置机器人

### 获取凭证

1. 登录企业微信管理后台：work.weixin.qq.com
2. 进入「管理工具」→「智能机器人」
3. 点击「创建机器人」→「手动创建」
4. 在「API 配置」中选择「使用长连接」
5. 获取 Bot ID 和 Secret

### 项目级配置

每个项目可独立配置机器人：

\`\`\`bash
cd /path/to/your/project
npx @vrs-soft/wecom-aibot-mcp --config
\`\`\`

配置文件：\`{项目}/.claude/wecom-aibot/config.json\`

## 可用工具

- \`send_message\` - 发送消息
- \`send_approval_request\` - 发送审批请求
- \`get_approval_result\` - 获取审批结果
- \`check_connection\` - 检查连接状态
- \`get_pending_messages\` - 获取用户消息
- \`list_robots\` - 列出所有机器人
- \`get_robot_status\` - 获取机器人状态
- \`enter_headless_mode\` - 进入微信模式
- \`exit_headless_mode\` - 退出微信模式
`;

      return {
        content: [
          {
            type: 'text',
            text: guide,
          },
        ],
      };
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
      default_user: z.string().optional().describe('默认目标用户（可选，可通过消息检测）'),
    },
    async ({ name, bot_id, secret, default_user }) => {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              message: '请使用 --add 命令添加机器人配置',
              command: `npx @vrs-soft/wecom-aibot-mcp --add`,
              config: {
                name,
                botId: bot_id,
                secret: secret.slice(0, 8) + '...',
                defaultUser: default_user,
              },
            }, null, 2),
          },
        ],
      };
    }
  );

  // ============================================
  // 工具 8: 列出所有机器人
  // ============================================
  server.tool(
    'list_robots',
    '列出配置中的所有机器人及其占用状态',
    {},
    async () => {
      const stats = getStats();
      const headlessStates = getAllHeadlessStates();

      const robots = stats.projects.map(p => ({
        projectDir: p.projectDir,
        status: p.connected ? 'connected' : 'disconnected',
        defaultUser: p.defaultUser,
        occupiedBy: headlessStates.find(s => s.state.projectDir === p.projectDir)?.state.agentName,
      }));

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              robots,
              total: robots.length,
              available: robots.filter(r => r.status === 'connected').length,
            }, null, 2),
          },
        ],
      };
    }
  );

  // ============================================
  // 工具 9: 获取机器人状态
  // ============================================
  server.tool(
    'get_robot_status',
    '检查指定机器人的详细状态',
    {
      robot_id: z.string().optional().describe('机器人 ID（projectDir，可选）'),
    },
    async ({ robot_id }) => {
      const dir = robot_id || process.cwd();
      const projectClient = getClient(dir);

      if (!projectClient) {
        const source = getConfigSource(dir);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                robotId: dir,
                status: source === 'none' ? 'not_configured' : 'disconnected',
                configSource: source,
              }, null, 2),
            },
          ],
        };
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              robotId: dir,
              status: projectClient.isConnected() ? 'connected' : 'disconnected',
              defaultUser: projectClient.getDefaultTargetUser(),
            }, null, 2),
          },
        ],
      };
    }
  );

  // ============================================
  // 工具 10: 进入 headless 模式
  // ============================================
  server.tool(
    'enter_headless_mode',
    '进入微信模式，配置项目级 Hook，建立 WebSocket 连接。当用户说「现在开始通过微信联系」时调用。',
    {
      agent_name: z.string().describe('智能体名称（用于消息名签）'),
      project_dir: z.string().optional().describe('项目目录路径（可选）'),
      robot_id: z.string().optional().describe('指定机器人 ID（可选）'),
      force: z.boolean().optional().describe('强制使用（即使被占用，可选）'),
    },
    async ({ agent_name, project_dir, robot_id, force }) => {
      try {
        // 确定项目目录
        const dir = project_dir || robot_id || process.cwd();

        // 检查配置
        const config = getConfig(dir);
        if (!config) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  status: 'error',
                  message: '请先配置机器人: npx @vrs-soft/wecom-aibot-mcp --config',
                }),
              },
            ],
          };
        }

        // 进入 headless 模式
        const state = enterHeadlessMode(dir, agent_name);

        // 发送确认消息
        await client.sendText(`【${agent_name}】已进入微信模式，所有交互将通过企业微信进行。`);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                status: 'entered',
                headless: true,
                projectDir: dir,
                message: '审批请求将通过微信发送',
              }),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                status: 'error',
                message: (err as Error).message,
              }),
            },
          ],
        };
      }
    }
  );

  // ============================================
  // 工具 11: 退出 headless 模式
  // ============================================
  server.tool(
    'exit_headless_mode',
    '退出微信模式，清除配置。当用户说「结束微信模式」或「我回来了」时调用。',
    {
      agent_name: z.string().optional().describe('智能体名称（可选）'),
    },
    async ({ agent_name }) => {
      try {
        const state = exitHeadlessMode();

        if (!state) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  status: 'error',
                  message: '未在微信模式',
                }),
              },
            ],
          };
        }

        // 发送退出通知
        const name = agent_name || state.agentName || '智能体';
        await client.sendText(`【${name}】已退出微信模式，恢复终端交互。`);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                status: 'exited',
                headless: false,
                message: '审批将使用默认 UI',
              }),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                status: 'error',
                message: (err as Error).message,
              }),
            },
          ],
        };
      }
    }
  );

  // ============================================
  // 工具 12: 从消息识别用户
  // ============================================
  server.tool(
    'detect_user_from_message',
    '等待用户发送消息并返回正确的用户 ID。用于配置时识别正确的企业微信账号。',
    {
      timeout: z.number().optional().describe('等待超时时间（秒），默认 60 秒'),
    },
    async ({ timeout = 60 }) => {
      const timeoutMs = timeout * 1000;
      const startTime = Date.now();

      console.log(`[mcp] 等待用户消息（超时: ${timeout}秒）...`);

      // 轮询等待消息
      while (Date.now() - startTime < timeoutMs) {
        const messages = client.getPendingMessages(false);
        if (messages.length > 0) {
          const msg = messages[0];
          const result = {
            userId: msg.from_userid,
            chatId: msg.chatid,
            chatType: msg.chattype,
            message: msg.content,
            hint: `正确的用户 ID 是: ${msg.from_userid}`,
          };
          // 清空消息队列
          client.getPendingMessages(true);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        }
        // 等待 1 秒后再检查
        await new Promise(resolve => setTimeout(resolve, 1000));
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: 'timeout',
              message: `等待超时（${timeout}秒），未收到用户消息`,
              hint: '请让目标用户在企业微信中给机器人发送一条消息后重试',
            }),
          },
        ],
      };
    }
  );

  // ============================================
  // 工具 13: 设置自动审批开关
  // ============================================
  server.tool(
    'set_auto_approve',
    '设置超时自动审批开关。开启后，审批请求超时（10分钟）将自动决策：项目内操作允许，删除操作拒绝。',
    {
      enabled: z.boolean().describe('是否启用自动审批'),
    },
    async ({ enabled }) => {
      const state = loadHeadlessState();

      if (!state) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                status: 'error',
                message: '未在 headless 模式，请先进入微信模式',
              }),
            },
          ],
        };
      }

      // 更新状态
      const updatedState = setAutoApprove(enabled);

      // 发送确认消息
      const statusText = enabled ? '已开启' : '已关闭';
      await client.sendText(`【系统】自动审批${statusText}\n\n${enabled ? '超时 10 分钟后将自动处理审批请求。' : '审批请求将一直等待您的响应。'}`);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              status: 'success',
              autoApprove: updatedState?.autoApprove,
              message: `自动审批已${statusText}`,
            }),
          },
        ],
      };
    }
  );

  console.log('[mcp] 已注册 13 个工具: send_message, send_approval_request, get_approval_result, check_connection, get_pending_messages, get_setup_guide, add_robot_config, list_robots, get_robot_status, enter_headless_mode, exit_headless_mode, detect_user_from_message, set_auto_approve');
}