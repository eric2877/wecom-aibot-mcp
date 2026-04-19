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
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { VERSION } from './config-wizard.js';
import { addPermissionHook, registerActiveProject, unregisterActiveProject } from './project-config.js';

const MCP_URL = process.env.MCP_URL || 'http://127.0.0.1:18963';
const MCP_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN;

// 构建带 auth 的 fetch headers
function getAuthHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  if (MCP_AUTH_TOKEN) {
    headers['Authorization'] = `Bearer ${MCP_AUTH_TOKEN}`;
  }
  return headers;
}

// Channel 日志文件
const CHANNEL_LOG_FILE = path.join(os.homedir(), '.wecom-aibot-mcp', 'channel.log');

/**
 * 写入 Channel 日志
 */
function logChannel(message: string, data?: any): void {
  const timestamp = new Date().toISOString();
  const logLine = `[${timestamp}] ${message}${data ? ` | ${JSON.stringify(data)}` : ''}\n`;

  // 写入日志文件
  try {
    fs.appendFileSync(CHANNEL_LOG_FILE, logLine);
  } catch (err) {
    console.error(`[channel] 日志写入失败: ${err}`);
  }

  // 同时输出到 stderr
  console.error(`[channel] ${message}${data ? ` | ${JSON.stringify(data).slice(0, 200)}` : ''}`);
}

// SSE 连接状态
let sseConnected = false;
let sseAbortController: AbortController | null = null;
let mcpServer: McpServer | null = null;
let sseCurrentCcId: string | undefined = undefined;

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
        ...getAuthHeaders(),
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
      logChannel('HTTP MCP session initialized', { sessionId });
      return sessionId;
    }

    // SSE 响应可能没有 header，需要解析 body
    const text = await res.text();
    const match = text.match(/mcp-session-id:\s*(\S+)/i);
    if (match) {
      httpSessionId = match[1];
      logChannel('HTTP MCP session from body', { sessionId: httpSessionId });
      return httpSessionId;
    }

    logChannel('Failed to get HTTP MCP session ID');
    return null;
  } catch (err) {
    logChannel('HTTP MCP init error', { error: String(err) });
    return null;
  }
}

/**
 * 转发请求到 HTTP MCP
 */
async function forwardToHttpMcp(toolName: string, params: Record<string, unknown>): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  logChannel('转发请求到 HTTP MCP', { toolName, params });

  // 确保已初始化 HTTP session
  const sessionId = await initHttpSession();
  if (!sessionId) {
    logChannel('转发失败: HTTP MCP session 未初始化');
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
      ...getAuthHeaders(),
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
      logChannel('解析响应失败', { text: text.slice(0, 100) });
    }
  }

  if (data?.error) {
    logChannel('HTTP MCP 返回错误', { error: data.error });
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ error: data.error.message || 'MCP request failed' }),
      }],
    };
  }

  // HTTP MCP 返回的 result（包含 content 数组）
  logChannel('转发成功', { result: data.result });
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
  if (sseConnected) {
    logChannel('SSE already connected, skip');
    return;
  }
  sseConnected = true;
  sseCurrentCcId = ccId;

  // SSE URL 添加 ccId 查询参数用于授权验证
  const sseUrl = ccId ? `${MCP_URL}/sse/${ccId}?ccId=${ccId}` : `${MCP_URL}/sse`;
  logChannel('Connecting to SSE', { url: sseUrl, ccId, mcpServerReady: mcpServer ? 'yes' : 'no' });

  sseAbortController = new AbortController();

  // SSE fetch 配置：添加 keep-alive headers 确保连接稳定
  fetch(sseUrl, {
    method: 'GET',
    signal: sseAbortController.signal,
    headers: {
      'Accept': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      ...getAuthHeaders(),
    },
  }).then(async (res) => {
    if (!res.ok) {
      logChannel('SSE connect failed', { status: res.status });
      sseConnected = false;
      return;
    }

    logChannel('SSE connected, waiting for messages', { status: res.status });

    const reader = res.body?.getReader();
    if (!reader) {
      logChannel('No response body');
      sseConnected = false;
      return;
    }

    const decoder = new TextDecoder();
    let buffer = '';
    let messageCount = 0;

    // 添加心跳监控
    const heartbeatInterval = setInterval(() => {
      logChannel('SSE heartbeat', { connected: sseConnected, messages: messageCount });
    }, 30000);

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        logChannel('SSE stream ended');
        clearInterval(heartbeatInterval);
        sseConnected = false;
        // 非主动断开时自动重连
        if (!sseAbortController?.signal.aborted) {
          logChannel('SSE 断线，3 秒后重连', { ccId });
          setTimeout(() => connectSSE(ccId), 3000);
        }
        break;
      }

      const chunk = decoder.decode(value, { stream: true });
      logChannel('SSE chunk received', { bytes: chunk.length, preview: chunk.slice(0, 100) });
      buffer += chunk;

      // 解析 SSE 事件
      const lines = buffer.split('\n');
      buffer = '';

      for (const line of lines) {
        logChannel('SSE line', { line: line.slice(0, 80) });

        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          logChannel('📩 SSE MESSAGE RECEIVED', { data: data.slice(0, 100) });
          try {
            const msg = JSON.parse(data);
            messageCount++;
            logChannel('✅ 消息解析成功', { messageNumber: messageCount, msg });

            // 推送 notifications/claude/channel 唤醒 Claude agent
            if (mcpServer) {
              // content 成为 <channel> 标签正文，meta 成为标签属性（只允许字母/数字/下划线）
              const message = msg.message || {};
              const notification = {
                method: 'notifications/claude/channel',
                params: {
                  content: message.content || JSON.stringify(msg),
                  meta: {
                    from: message.from || '',
                    chatid: message.chatid || '',
                    chattype: message.chattype || 'single',
                    cc_id: msg.ccId || '',
                    quote_content: message.quoteContent || '',
                  } as Record<string, string>,
                },
              };
              logChannel('📤 发送 notification', { notification });

              try {
                mcpServer.server.notification(notification);
                logChannel('✅ NOTIFICATION 发送成功', { notification });
              } catch (notifyErr) {
                logChannel('❌ NOTIFICATION 发送失败', { error: String(notifyErr) });
              }
            } else {
              logChannel('❌ ERROR: mcpServer is null');
            }
          } catch (e) {
            logChannel('JSON parse error', { error: String(e), data: data.slice(0, 50) });
          }
        } else if (line.startsWith('event: ')) {
          logChannel('SSE event type', { type: line.slice(7) });
        } else if (line === '') {
          // 事件分隔符，忽略
        } else if (line.startsWith(':')) {
          // SSE 注释（如 ": heartbeat"），忽略，不要写回 buffer
        } else {
          // 可能是跨行 JSON 的一部分
          buffer = line;
        }
      }
    }

    clearInterval(heartbeatInterval);
  }).catch((err) => {
    logChannel('SSE error', { error: String(err) });
    sseConnected = false;
    // 非主动断开时自动重连
    if (!sseAbortController?.signal.aborted) {
      logChannel('SSE 出错，3 秒后重连', { ccId });
      setTimeout(() => connectSSE(ccId), 3000);
    }
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
  // 工具 3: 保存心跳 job ID（HTTP 模式）
  // ============================================
  server.tool(
    'update_heartbeat_job_id',
    '保存心跳定时任务 job ID 到配置文件（HTTP 模式用，/loop 创建后调用）',
    {
      cc_id: z.string().describe('CC 唯一标识'),
      job_id: z.string().describe('由 /loop 命令返回的 job ID'),
    },
    async ({ cc_id, job_id }) => {
      return forwardToHttpMcp('update_heartbeat_job_id', { cc_id, job_id });
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
      doc_mcp_url: z.string().optional().describe('机器人文档 MCP URL（企业微信文档能力）'),
    },
    async ({ name, bot_id, secret, default_user, doc_mcp_url }) => {
      return forwardToHttpMcp('add_robot_config', { name, bot_id, secret, default_user, doc_mcp_url });
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
        project_dir: project_dir || process.cwd(),
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
              logChannel('Got ccId, connecting SSE', { ccId: parsed.ccId, mode });
              connectSSE(parsed.ccId);

              // Channel 模式：在本地项目写入 PermissionRequest hook
              const localProjectDir = project_dir || process.cwd();
              const hookResult = addPermissionHook(localProjectDir);
              logChannel('本地 PermissionRequest hook 已写入', { path: hookResult.path, success: hookResult.success });

              // 注册本地 PID → projectDir（供本地 permission-hook.sh 通过进程树匹配项目）
              registerActiveProject(process.ppid ?? process.pid, localProjectDir);
              logChannel('本地 active-projects 已注册', { pid: process.ppid ?? process.pid, projectDir: localProjectDir });

              // Channel 模式：过滤 heartbeat 信息，简化消息
              if (mode === 'channel' || parsed.mode === 'channel') {
                delete parsed.heartbeat;  // Channel 模式不需要 heartbeat loop
                parsed.message = `已进入微信模式(Channel)，消息将通过 SSE 自动推送`;
                content[0].text = JSON.stringify(parsed);
                logChannel('enter_headless_mode 响应已处理', { parsed });
              }
            }
          } catch (e) {
            logChannel('JSON 解析失败', { error: String(e) });
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
      const localProjectDir = project_dir || process.cwd();

      // 断开 SSE 连接（abort 后重连逻辑不会触发）
      if (sseAbortController) {
        sseAbortController.abort();
        sseAbortController = null;
        sseConnected = false;
        sseCurrentCcId = undefined;
        logChannel('SSE disconnected', { cc_id });
      }

      // 注销本地 active-projects 记录
      unregisterActiveProject(localProjectDir);
      logChannel('本地 active-projects 已注销', { projectDir: localProjectDir });

      return forwardToHttpMcp('exit_headless_mode', { cc_id, project_dir: localProjectDir });
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
      const res = await fetch(`${MCP_URL}/skill`, {
        headers: getAuthHeaders(),
      });
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

  // ============================================
  // 文档代理工具（转发到 HTTP MCP）
  // ============================================
  const docTools: Array<[string, string, Record<string, z.ZodTypeAny>]> = [
    ['create_doc', '新建文档或智能表格', {
      doc_type: z.number().int().describe('文档类型：3=文档，10=智能表格'),
      doc_name: z.string().describe('文档名称'),
      robot_name: z.string().optional().describe('指定机器人名称（多机器人时必填）'),
    }],
    ['get_doc_content', '获取文档内容（Markdown 格式）', {
      type: z.number().int().describe('内容格式：2=Markdown'),
      url: z.string().optional().describe('文档链接'),
      docid: z.string().optional().describe('文档 docid'),
      task_id: z.string().optional().describe('任务 ID（轮询时填写）'),
      robot_name: z.string().optional().describe('指定机器人名称（多机器人时必填）'),
    }],
    ['edit_doc_content', '编辑文档内容（Markdown 格式覆写）', {
      content: z.string().describe('覆写的文档内容'),
      content_type: z.number().int().describe('内容类型：1=Markdown'),
      url: z.string().optional().describe('文档链接'),
      docid: z.string().optional().describe('文档 docid'),
      robot_name: z.string().optional().describe('指定机器人名称（多机器人时必填）'),
    }],
    ['smartsheet_get_sheet', '查询智能表格子表信息', {
      url: z.string().optional(), docid: z.string().optional(),
      robot_name: z.string().optional(),
    }],
    ['smartsheet_add_sheet', '添加智能表格子表', {
      url: z.string().optional(), docid: z.string().optional(),
      properties: z.object({ title: z.string().optional() }).optional(),
      robot_name: z.string().optional(),
    }],
    ['smartsheet_update_sheet', '更新智能表格子表标题', {
      properties: z.object({ sheet_id: z.string(), title: z.string() }),
      url: z.string().optional(), docid: z.string().optional(),
      robot_name: z.string().optional(),
    }],
    ['smartsheet_delete_sheet', '删除智能表格子表', {
      sheet_id: z.string(), url: z.string().optional(), docid: z.string().optional(),
      robot_name: z.string().optional(),
    }],
    ['smartsheet_get_fields', '查询智能表格字段', {
      sheet_id: z.string(), url: z.string().optional(), docid: z.string().optional(),
      robot_name: z.string().optional(),
    }],
    ['smartsheet_add_fields', '添加智能表格字段', {
      sheet_id: z.string(),
      fields: z.array(z.object({ field_title: z.string(), field_type: z.string() })),
      url: z.string().optional(), docid: z.string().optional(),
      robot_name: z.string().optional(),
    }],
    ['smartsheet_update_fields', '更新智能表格字段标题', {
      sheet_id: z.string(),
      fields: z.array(z.object({ field_id: z.string(), field_title: z.string(), field_type: z.string() })),
      url: z.string().optional(), docid: z.string().optional(),
      robot_name: z.string().optional(),
    }],
    ['smartsheet_delete_fields', '删除智能表格字段', {
      sheet_id: z.string(), field_ids: z.array(z.string()),
      url: z.string().optional(), docid: z.string().optional(),
      robot_name: z.string().optional(),
    }],
    ['smartsheet_get_records', '查询智能表格记录', {
      sheet_id: z.string(), url: z.string().optional(), docid: z.string().optional(),
      robot_name: z.string().optional(),
    }],
    ['smartsheet_add_records', '添加智能表格记录', {
      sheet_id: z.string(),
      records: z.array(z.object({ values: z.record(z.string(), z.unknown()) })),
      url: z.string().optional(), docid: z.string().optional(),
      robot_name: z.string().optional(),
    }],
    ['smartsheet_update_records', '更新智能表格记录', {
      sheet_id: z.string(),
      records: z.array(z.object({ record_id: z.string(), values: z.record(z.string(), z.unknown()) })),
      key_type: z.enum(['CELL_VALUE_KEY_TYPE_FIELD_TITLE', 'CELL_VALUE_KEY_TYPE_FIELD_ID']),
      url: z.string().optional(), docid: z.string().optional(),
      robot_name: z.string().optional(),
    }],
    ['smartsheet_delete_records', '删除智能表格记录', {
      sheet_id: z.string(), record_ids: z.array(z.string()),
      url: z.string().optional(), docid: z.string().optional(),
      robot_name: z.string().optional(),
    }],
  ];

  for (const [toolName, description, schema] of docTools) {
    server.tool(toolName, description, schema, async (args: Record<string, unknown>) => {
      return forwardToHttpMcp(toolName, args);
    });
  }

  logChannel('Registered 28 tools (13 core + 15 doc proxy)');
}

/**
 * 启动 Channel MCP Server
 */
export async function startChannelServer(): Promise<void> {
  logChannel('Starting Channel MCP Proxy');

  // 创建 MCP Server
  mcpServer = new McpServer({
    name: 'wecom-aibot-channel',
    version: VERSION,
  }, {
    capabilities: {
      // 必须声明 experimental['claude/channel']，Claude Code 才会注册 notification listener
      experimental: { 'claude/channel': {} },
      tools: {},
    },
    // 告知 Claude 如何处理 channel 事件
    instructions: '企业微信消息通过 <channel> 标签推送。属性说明：from=发送者userid, chatid=会话ID(单聊=用户ID,群聊=群ID), chattype=single|group, cc_id=当前会话标识。【强制规则】收到任何用户消息后，必须先执行步骤1再执行步骤2，禁止跳过：1) 立即发送确认 send_message(cc_id, "收到，正在处理...", target_user=chatid)；2) 处理任务；3) 发送结果 send_message(cc_id, "【完成】...", target_user=chatid)。',
  });

  // 注册工具
  registerChannelTools(mcpServer);
  logChannel('Registered 13 tools');

  // 连接 stdio transport
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);

  logChannel('Connected to CC via stdio');
  logChannel('Channel MCP Proxy ready');
}