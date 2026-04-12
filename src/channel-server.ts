/**
 * Channel MCP 透明代理服务器
 *
 * 作为 HTTP MCP 的透明代理 + SSE Channel 唤醒能力
 *
 * 核心职责：
 * 1. 声明完整工具列表（和 HTTP MCP 完全一样）
 * 2. 转发所有请求到 HTTP MCP（需要初始化 session）
 * 3. enter_headless_mode 后建立 SSE 连接
 * 4. SSE 消息 → notifications/claude/channel 唤醒 agent
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const MCP_URL = process.env.MCP_URL || 'http://127.0.0.1:18963';

// SSE 连接状态
let sseConnected = false;
let sseAbortController: AbortController | null = null;
let mcpServer: McpServer | null = null;

// HTTP MCP session ID（需要在转发请求前初始化）
let httpSessionId: string | null = null;

/**
 * 初始化 HTTP MCP session
 */
async function initHttpSession(): Promise<string | null> {
  if (httpSessionId) return httpSessionId;

  try {
    const res = await fetch(`${MCP_URL}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'channel-proxy', version: '1.0' },
        },
        id: 1,
      }),
    });

    // 从响应 header 获取 session ID
    const sessionId = res.headers.get('mcp-session-id');
    if (sessionId) {
      httpSessionId = sessionId;
      console.error(`[channel] HTTP MCP session initialized: ${sessionId}`);
      return sessionId;
    }

    // SSE 响应可能没有 header，需要解析 body
    const text = await res.text();
    const match = text.match(/mcp-session-id:\s*(\S+)/i);
    if (match) {
      httpSessionId = match[1];
      console.error(`[channel] HTTP MCP session from body: ${httpSessionId}`);
      return httpSessionId;
    }

    console.error('[channel] Failed to get HTTP MCP session ID');
    return null;
  } catch (err) {
    console.error(`[channel] HTTP MCP init error: ${err}`);
    return null;
  }
}

/**
 * 转发请求到 HTTP MCP
 */
async function forwardToHttpMcp(toolName: string, params: Record<string, unknown>): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  // 确保已初始化 HTTP session
  const sessionId = await initHttpSession();
  if (!sessionId) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ error: 'Failed to initialize HTTP MCP session' }),
      }],
    };
  }

  const res = await fetch(`${MCP_URL}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'mcp-session-id': sessionId,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: toolName, arguments: params },
      id: Date.now(),
    }),
  });

  // 解析 SSE 响应
  const text = await res.text();
  let data: any = null;

  // SSE 格式: event: message\n data: {...}
  // 需要处理多行 JSON（包含 \n 转义字符）
  const lines = text.split('\n');
  for (const line of lines) {
    if (line.startsWith('data: ')) {
      // 提取 data 后的 JSON（可能跨多行，但 MCP 响应通常是单行）
      const jsonStr = line.slice(6);
      try {
        data = JSON.parse(jsonStr);
        break;
      } catch (e) {
        // JSON 解析失败，可能需要合并多行
      }
    }
  }

  // 如果 SSE 解析失败，尝试直接解析 JSON
  if (!data) {
    try {
      data = JSON.parse(text);
    } catch (e) {
      console.error(`[channel] Failed to parse response: ${text.slice(0, 100)}`);
    }
  }

  if (data?.error) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ error: data.error.message || 'MCP request failed' }),
      }],
    };
  }

  // HTTP MCP 返回的 result（包含 content 数组）
  return data.result || {
    content: [{
      type: 'text',
      text: JSON.stringify({ error: 'Empty result from HTTP MCP' }),
    }],
  };
}

/**
 * 建立 SSE 连接（enter_headless_mode 后调用）
 */
function connectSSE(ccId?: string): void {
  if (sseConnected) return;
  sseConnected = true;

  const sseUrl = ccId ? `${MCP_URL}/sse/${ccId}` : `${MCP_URL}/sse`;
  console.error(`[channel] Connecting to SSE: ${sseUrl}`);

  sseAbortController = new AbortController();

  fetch(sseUrl, {
    method: 'GET',
    signal: sseAbortController.signal,
  }).then(async (res) => {
    if (!res.ok) {
      console.error(`[channel] SSE connect failed: ${res.status}`);
      sseConnected = false;
      return;
    }

    console.error('[channel] SSE connected');
    const reader = res.body?.getReader();
    if (!reader) {
      console.error('[channel] No response body');
      sseConnected = false;
      return;
    }

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        console.error('[channel] SSE stream ended');
        sseConnected = false;
        break;
      }

      buffer += decoder.decode(value, { stream: true });

      // 解析 SSE 事件
      const lines = buffer.split('\n');
      buffer = '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          try {
            const msg = JSON.parse(data);
            console.error(`[channel] SSE message received: ${JSON.stringify(msg).slice(0, 100)}`);

            // 推送 notifications/claude/channel
            if (mcpServer) {
              console.error('[channel] Sending notification: notifications/claude/channel');
              mcpServer.server.notification({
                method: 'notifications/claude/channel',
                params: {
                  content: JSON.stringify(msg),
                },
              });
              console.error('[channel] Notification sent');
            } else {
              console.error('[channel] ERROR: mcpServer is null, cannot send notification');
            }
          } catch (e) {
            console.error(`[channel] JSON parse error: ${e}`);
          }
        } else if (line.startsWith('event: ')) {
          // 事件类型行，记录事件类型
          console.error(`[channel] SSE event type: ${line.slice(7)}`);
        } else if (line === '') {
          // 事件分隔符，忽略
        } else {
          // 其他内容，可能是未完成的行
          buffer = line;
        }
      }
    }
  }).catch((err) => {
    console.error(`[channel] SSE error: ${err}`);
    sseConnected = false;
  });
}

/**
 * 注册所有工具（和 HTTP MCP 完全一样）
 */
function registerChannelTools(server: McpServer) {
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
    async ({ content, target_user, cc_id }) => {
      // 转发请求到 HTTP MCP，但拦截返回消息
      await forwardToHttpMcp('send_message', { content, target_user, cc_id });
      // 返回简单确认（不转发 HTTP MCP 的完整消息）
      return {
        content: [{ type: 'text', text: '✅ 消息已发送' }],
      };
    }
  );

  // ============================================
  // 工具 2: 心跳检查（HTTP 模式）
  // ============================================
  server.tool(
    'heartbeat_check',
    '心跳检查，提示智能体继续轮询（仅 HTTP 模式使用）',
    {},
    async () => {
      return forwardToHttpMcp('heartbeat_check', {});
    }
  );

  // ============================================
  // 工具 3: 检查连接状态
  // ============================================
  server.tool(
    'check_connection',
    '检查当前 WebSocket 连接状态',
    {},
    async () => {
      return forwardToHttpMcp('check_connection', {});
    }
  );

  // ============================================
  // 工具 4: 获取待处理消息
  // ============================================
  server.tool(
    'get_pending_messages',
    '获取待处理的微信消息。支持长轮询：传入 timeout_ms 后阻塞等待，有消息立即返回，无消息等到超时。超时后继续轮询，不要停止。',
    {
      clear: z.boolean().optional().default(true).describe('是否清除已获取的消息'),
      timeout_ms: z.number().optional().default(30000).describe('长轮询超时（毫秒），默认 30000，最大 60000'),
      cc_id: z.string().describe('CC 唯一标识（enter_headless_mode 返回的 ccId）'),
    },
    async ({ clear, timeout_ms, cc_id }) => {
      return forwardToHttpMcp('get_pending_messages', { clear, timeout_ms, cc_id });
    }
  );

  // ============================================
  // 工具 5: 获取安装配置指南
  // ============================================
  server.tool(
    'get_setup_guide',
    '获取企业微信 MCP 服务安装配置指南',
    {},
    async () => {
      return forwardToHttpMcp('get_setup_guide', {});
    }
  );

  // ============================================
  // 工具 6: 获取配置需求
  // ============================================
  server.tool(
    'get_setup_requirements',
    '获取 MCP 配置需求，用于 skill 自动配置本地环境（权限、Hook、skill）。启动时调用检查配置是否完整。',
    {},
    async () => {
      return forwardToHttpMcp('get_setup_requirements', {});
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
      return forwardToHttpMcp('add_robot_config', { name, bot_id, secret, default_user });
    }
  );

  // ============================================
  // 工具 8: 列出所有机器人
  // ============================================
  server.tool(
    'list_robots',
    '列出配置中的所有机器人。多 CC 可共享同一机器人，直接选择使用即可。',
    {},
    async () => {
      return forwardToHttpMcp('list_robots', {});
    }
  );

  // ============================================
  // 工具 9: 进入 headless 模式（关键：建立 SSE 连接）
  // ============================================
  server.tool(
    'enter_headless_mode',
    '进入微信模式，建立 WebSocket 连接。当用户说「现在开始通过微信联系」时调用。',
    {
      agent_name: z.string().optional().describe('智能体/项目名称（用于生成 ccId，如项目名）'),
      cc_id: z.string().optional().describe('CC 唯一标识（可选，未传入时服务端自动生成）'),
      robot_id: z.string().optional().describe('指定机器人名称或序号'),
      project_dir: z.string().optional().describe('项目目录路径（用于写入配置文件）'),
      mode: z.enum(['channel', 'http']).optional().default('http')
        .describe('运行模式：channel=SSE推送(推荐)，http=轮询(兼容)'),
      auto_approve: z.boolean().optional().default(true).describe('超时自动审批（默认 true）'),
      auto_approve_timeout: z.number().optional().default(600).describe('自动审批超时时间（秒，默认 600 即 10 分钟）'),
    },
    async ({ agent_name, cc_id, robot_id, project_dir, mode, auto_approve, auto_approve_timeout }) => {
      // 转发请求
      const result = await forwardToHttpMcp('enter_headless_mode', {
        agent_name,
        cc_id,
        robot_id,
        project_dir,
        mode,
        auto_approve,
        auto_approve_timeout,
      });

      // 拦截响应，提取 ccId，建立 SSE 连接
      if (result && typeof result === 'object' && 'content' in result) {
        const content = result.content as Array<{ type: string; text: string }>;
        if (content[0]?.text) {
          try {
            const parsed = JSON.parse(content[0].text);
            if (parsed.ccId) {
              console.error(`[channel] Got ccId: ${parsed.ccId}, connecting SSE...`);
              connectSSE(parsed.ccId);

              // Channel 模式：过滤 heartbeat 信息，简化消息
              if (mode === 'channel' || parsed.mode === 'channel') {
                delete parsed.heartbeat;  // Channel 模式不需要 heartbeat loop
                parsed.message = `已进入微信模式(Channel)，消息将通过 SSE 自动推送`;
                content[0].text = JSON.stringify(parsed);
              }
            }
          } catch (e) {
            // JSON 解析失败，忽略
          }
        }
      }

      return result;
    }
  );

  // ============================================
  // 工具 10: 退出 headless 模式
  // ============================================
  server.tool(
    'exit_headless_mode',
    '退出微信模式，断开连接。当用户说「结束微信模式」或「我回来了」时调用。',
    {
      cc_id: z.string().describe('CC 唯一标识（enter_headless_mode 返回的 ccId）'),
      project_dir: z.string().optional().describe('项目目录路径（用于更新配置文件）'),
    },
    async ({ cc_id, project_dir }) => {
      // 断开 SSE 连接
      if (sseAbortController) {
        sseAbortController.abort();
        sseAbortController = null;
        sseConnected = false;
        console.error('[channel] SSE disconnected');
      }

      return forwardToHttpMcp('exit_headless_mode', { cc_id, project_dir });
    }
  );

  // ============================================
  // 工具 11: 从消息识别用户
  // ============================================
  server.tool(
    'detect_user_from_message',
    '等待用户发送消息并返回用户 ID。',
    {
      timeout: z.number().optional().describe('超时时间（秒），默认 60'),
      cc_id: z.string().optional().describe('CC 唯一标识（enter_headless_mode 返回的 ccId）'),
    },
    async ({ timeout, cc_id }) => {
      return forwardToHttpMcp('detect_user_from_message', { timeout, cc_id });
    }
  );

  // ============================================
  // 工具 12: 获取连接状态统计
  // ============================================
  server.tool(
    'get_connection_stats',
    '获取连接状态统计和日志',
    { recent_logs: z.number().optional().describe('最近 N 条日志') },
    async ({ recent_logs }) => {
      return forwardToHttpMcp('get_connection_stats', { recent_logs });
    }
  );

  // ============================================
  // 工具 13: 获取 skill 文件内容
  // ============================================
  server.tool(
    'get_skill',
    '获取 headless-mode skill 文件内容，用于写入本地项目目录。远程部署时 HTTP MCP 可能不在本地，skill 文件需要从此接口获取。',
    {},
    async () => {
      // 直接请求 HTTP MCP 的 /skill 端点
      const res = await fetch(`${MCP_URL}/skill`);
      if (!res.ok) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ error: `获取 skill 失败: ${res.status}` }),
          }],
        };
      }
      const content = await res.text();
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ success: true, content, filename: 'SKILL.md' }),
        }],
      };
    }
  );

  console.error('[channel] Registered 13 tools');
}

/**
 * 启动 Channel MCP Server
 */
export async function startChannelServer(): Promise<void> {
  console.error('[channel] Starting Channel MCP Proxy...');

  // 创建 MCP Server
  mcpServer = new McpServer({
    name: 'wecom-aibot-channel',
    version: '2.0.0',
  }, {
    capabilities: {
      tools: {},
      experimental: { 'claude/channel': {} },  // 声明 channel 能力
    },
  });

  // 注册工具
  registerChannelTools(mcpServer);

  // 连接 stdio transport
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);

  console.error('[channel] Connected to CC via stdio');
  console.error('[channel] Channel MCP Proxy ready');
}