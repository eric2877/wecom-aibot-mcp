/**
 * MCP 工具注册入口
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as fs from 'fs';
import * as path from 'path';
import type { WecomClient } from '../client.js';
import { getHeadlessFilePath } from '../http-server.js';

const CONFIG_DIR = path.join(process.env.HOME || '/tmp', '.wecom-aibot-mcp');

// 进入 headless 模式（写入状态文件）
function enterHeadlessMode(): boolean {
  try {
    if (!fs.existsSync(CONFIG_DIR)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
    }
    fs.writeFileSync(getHeadlessFilePath(), String(Date.now()));
    console.log(`[mcp] 已进入 headless 模式: ${getHeadlessFilePath()}`);
    return true;
  } catch (err) {
    console.error(`[mcp] 进入 headless 模式失败: ${err}`);
    return false;
  }
}

// 退出 headless 模式（删除状态文件）
function exitHeadlessMode(): boolean {
  try {
    const headlessFile = getHeadlessFilePath();
    if (fs.existsSync(headlessFile)) {
      fs.unlinkSync(headlessFile);
      console.log(`[mcp] 已退出 headless 模式: ${headlessFile}`);
    }
    return true;
  } catch (err) {
    console.error(`[mcp] 退出 headless 模式失败: ${err}`);
    return false;
  }
}

// 检查是否在 headless 模式
function isHeadlessMode(): boolean {
  return fs.existsSync(getHeadlessFilePath());
}

export function registerTools(server: McpServer, client: WecomClient) {
  // ============================================
  // 工具 1: 发送文本消息
  // ============================================
  server.tool(
    'send_message',
    '向企业微信发送消息（用于通知用户）',
    {
      content: z.string().describe('消息内容（支持 Markdown）'),
      target_user: z.string().optional().describe('目标用户 ID（可选，默认使用配置的 TARGET_USER_ID）'),
    },
    async ({ content, target_user }) => {
      const success = await client.sendText(content, target_user);
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
      request_id: z.string().describe('请求 ID（用于关联审批结果）'),
      target_user: z.string().optional().describe('目标用户 ID（可选，默认使用配置的 TARGET_USER_ID）'),
    },
    async ({ title, description, request_id, target_user }) => {
      try {
        const taskId = await client.sendApprovalRequest(title, description, request_id, target_user);
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
    '查询审批任务当前状态（非阻塞，立即返回）。返回值：pending（等待中）、allow-once（允许一次）、allow-always（永久允许）、deny（拒绝）。',
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
    '检查企业微信长连接状态和默认目标用户',
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
    '获取用户主动发送的待处理消息（非阻塞，立即返回队列中所有消息）。如需持续监控用户消息，建议轮询间隔 5 秒。注意：如果 agent 正在忙碌，消息会在队列中累积，调用此工具可一次性获取。',
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
          time: new Date(m.timestamp).toISOString(),
        })),
        hint: messages.length > 0
          ? '以上是用户主动发送的消息，请根据内容决定如何处理'
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
  // 工具 5: 获取安装配置指南
  // ============================================
  server.tool(
    'get_setup_guide',
    '获取企业微信 MCP 服务安装配置指南（首次安装必读）',
    {},
    async () => {
      const guide = `
# 企业微信智能机器人 MCP 服务 - 安装配置指南

## 安装方式

\`\`\`bash
npx @various/wecom-aibot-mcp
\`\`\`

## 首次配置

首次运行需要提供以下信息：
1. **Bot ID** - 企业微信智能机器人 ID
2. **Secret** - 智能机器人密钥
3. **Target User** - 默认目标用户 ID（审批请求发给谁）

## ⚠️ 重要：权限预授权（自动完成）

**首次运行配置向导时，会自动写入权限配置，无需手动配置！**

配置向导会自动将以下权限添加到 \`~/.claude/settings.local.json\`：

\`\`\`json
{
  "permissions": {
    "allow": [
      "mcp__wecom-aibot__send_message",
      "mcp__wecom-aibot__send_approval_request",
      "mcp__wecom-aibot__get_approval_result",
      "mcp__wecom-aibot__check_connection",
      "mcp__wecom-aibot__get_pending_messages",
      "mcp__wecom-aibot__get_setup_guide",
      "mcp__wecom-aibot__add_robot_config"
    ]
  }
}
\`\`\`

**为什么必须预授权？**
- 如果不预授权，调用工具时会弹出确认对话框
- headless 模式下你不在电脑前，无法点击确认
- 工作流会被阻断，任务无法完成

> ⚠️ 如果权限写入失败，请手动添加上述配置

## 在 Claude Code 中配置

编辑 \`~/.claude.json\`，在 \`mcpServers\` 中添加：

\`\`\`json
{
  "mcpServers": {
    "wecom-aibot": {
      "command": "npx",
      "args": ["@various/wecom-aibot-mcp"],
      "env": {
        "WECOM_BOT_ID": "your_bot_id",
        "WECOM_SECRET": "your_secret",
        "WECOM_TARGET_USER": "your_userid"
      }
    }
  }
}
\`\`\`

## 多用户/多机器人配置

每个用户可以使用不同的机器人，只需配置不同的环境变量：

\`\`\`json
{
  "mcpServers": {
    "wecom-aibot-zhangsan": {
      "command": "npx",
      "args": ["@various/wecom-aibot-mcp"],
      "env": {
        "WECOM_BOT_ID": "bot_zhangsan",
        "WECOM_SECRET": "secret_zhangsan",
        "WECOM_TARGET_USER": "zhangsan"
      }
    },
    "wecom-aibot-lisi": {
      "command": "npx",
      "args": ["@various/wecom-aibot-mcp"],
      "env": {
        "WECOM_BOT_ID": "bot_lisi",
        "WECOM_SECRET": "secret_lisi",
        "WECOM_TARGET_USER": "lisi"
      }
    }
  }
}
\`\`\`

## 获取凭证

1. 登录企业微信管理后台：work.weixin.qq.com
2. 进入「管理工具」→「智能机器人」
3. 点击「创建机器人」→「手动创建」
4. 在「API 配置」中选择「使用长连接」
5. 获取 Bot ID 和 Secret

## 可用工具

- \`send_message\` - 发送消息到企业微信
- \`send_approval_request\` - 发送审批请求（带按钮卡片，阻塞等待响应）
- \`get_approval_result\` - 获取审批结果（阻塞，永不过期）
- \`check_connection\` - 检查连接状态
- \`get_pending_messages\` - 获取用户消息（非阻塞，建议轮询间隔 5 秒）
- \`get_setup_guide\` - 获取本指南
- \`add_robot_config\` - 生成新机器人配置片段
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
  // 工具 6: 添加新机器人配置
  // ============================================
  server.tool(
    'add_robot_config',
    '生成新机器人 MCP 配置片段（用于添加更多用户/机器人）',
    {
      instance_name: z.string().describe('MCP 实例名称（如 wecom-aibot-zhangsan）'),
      bot_id: z.string().describe('企业微信机器人 ID'),
      secret: z.string().describe('机器人密钥'),
      target_user: z.string().describe('默认目标用户 ID'),
    },
    async ({ instance_name, bot_id, secret, target_user }) => {
      const config = {
        "command": "npx",
        "args": ["@various/wecom-aibot-mcp"],
        "env": {
          "WECOM_BOT_ID": bot_id,
          "WECOM_SECRET": secret,
          "WECOM_TARGET_USER": target_user
        }
      };

      const jsonSnippet = JSON.stringify({ [instance_name]: config }, null, 2);

      const instructions = `
## 新机器人配置已生成

将以下配置添加到 \`~/.claude.json\` 的 \`mcpServers\` 中：

\`\`\`json
${jsonSnippet}
\`\`\`

### 添加后完整示例：

\`\`\`json
{
  "mcpServers": {
    "wecom-aibot": {
      "command": "npx",
      "args": ["@various/wecom-aibot-mcp"],
      "env": {
        "WECOM_BOT_ID": "existing_bot",
        "WECOM_SECRET": "existing_secret",
        "WECOM_TARGET_USER": "existing_user"
      }
    },
    ${jsonSnippet.slice(1, -1)}
  }
}
\`\`\`

### 下一步：
1. 将配置添加到 \`~/.claude.json\`
2. 运行 \`/mcp\` 重新加载配置
3. 新机器人即可使用

### 注意：
- 每个机器人同时只能保持一个长连接
- 不同用户使用不同机器人，避免冲突
`;

      return {
        content: [
          {
            type: 'text',
            text: instructions,
          },
        ],
      };
    }
  );

  // ============================================
  // 工具 8: 进入 headless 模式
  // ============================================
  server.tool(
    'enter_headless_mode',
    '进入 headless 微信模式（审批通过微信发送）。当用户说「现在开始通过微信联系」时调用。',
    {},
    async () => {
      const success = enterHeadlessMode();
      return {
        content: [
          {
            type: 'text',
            text: success
              ? JSON.stringify({ status: 'entered', headless: true, message: '审批请求将通过微信发送' })
              : JSON.stringify({ status: 'error', message: '进入 headless 模式失败' }),
          },
        ],
      };
    }
  );

  // ============================================
  // 工具 9: 退出 headless 模式
  // ============================================
  server.tool(
    'exit_headless_mode',
    '退出 headless 微信模式（审批回退到默认 UI）。当用户说「结束微信模式」或「我回来了」时调用。',
    {},
    async () => {
      const success = exitHeadlessMode();
      return {
        content: [
          {
            type: 'text',
            text: success
              ? JSON.stringify({ status: 'exited', headless: false, message: '审批将使用默认 UI' })
              : JSON.stringify({ status: 'error', message: '退出 headless 模式失败' }),
          },
        ],
      };
    }
  );

  console.log('[mcp] 已注册 9 个工具: send_message, send_approval_request, get_approval_result, check_connection, get_pending_messages, get_setup_guide, add_robot_config, enter_headless_mode, exit_headless_mode');
}