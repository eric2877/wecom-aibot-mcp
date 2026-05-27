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
import { execSync } from 'child_process';
import { VERSION, installSkill } from './config-wizard.js';
import { addPermissionHook, registerActiveProject, unregisterActiveProject, updateWechatModeConfig } from './project-config.js';
import { logger } from './logger.js';

/**
 * 沿进程树向上查找 Claude Code TUI 的 PID。
 *
 * 背景：本地 dev (`command: "node"`) 时 channel-server 是 Claude TUI 的直接子进程，
 *   process.ppid = Claude TUI ✓
 * 但 npx 部署 (`command: "npx"`) 时多了一层 npx：
 *   Claude TUI → npx → node bin.js (channel-server)
 *   process.ppid = npx ❌
 * permission-hook.sh 从 hook 自身向上查 active-projects.json 时只能命中 Claude TUI
 * 这条祖先链。如果注册的是 npx 的 PID，hook 永远找不到 → 静默 exit 0 → 跳过审批。
 *
 * 此函数从 startPid 起向上遍历，找到第一个命令名为 "claude" 的进程，返回其 PID。
 * 找不到时回退到 startPid（保持旧行为，至少 dev 场景不退化）。
 */
function findClaudePid(startPid: number): number {
  let pid = startPid;
  for (let i = 0; i < 8; i++) {
    if (!pid || pid <= 1) break;
    try {
      const comm = execSync(`ps -p ${pid} -o comm=`, { stdio: ['ignore', 'pipe', 'ignore'] })
        .toString()
        .trim();
      // ps comm= 返回执行文件 basename。Claude Code TUI 安装名就是 "claude"
      if (comm === 'claude' || comm.endsWith('/claude')) return pid;
      const ppidStr = execSync(`ps -p ${pid} -o ppid=`, { stdio: ['ignore', 'pipe', 'ignore'] })
        .toString()
        .trim();
      const ppid = parseInt(ppidStr, 10);
      if (!ppid || ppid === pid) break;
      pid = ppid;
    } catch {
      break;
    }
  }
  return startPid;
}

const MCP_URL = process.env.MCP_URL || 'http://127.0.0.1:18963';
const MCP_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN;

// ============================================
// 文件传输辅助（v3.2.0）—— channel-server 本地 fs + HTTP 直传 daemon
// ============================================

const MIME_BY_EXT: Record<string, string> = {
  '.md': 'text/markdown', '.txt': 'text/plain', '.json': 'application/json',
  '.yaml': 'application/yaml', '.yml': 'application/yaml', '.toml': 'application/toml',
  '.ts': 'text/typescript', '.js': 'text/javascript', '.py': 'text/x-python',
  '.html': 'text/html', '.css': 'text/css', '.csv': 'text/csv',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf', '.zip': 'application/zip',
};

interface UploadArgs {
  kind: 'document' | 'shared';
  cc_id: string;
  to_cc?: string;
  file_path: string;
  title?: string;
  mime_type?: string;
  ttl_seconds?: number;
  tags?: string[];
}

// v3.2.4: 发媒体给 wecom 用户
interface SendWecomMediaArgs {
  cc_id: string;
  target_user: string;
  file_path: string;
  media_type: 'image' | 'file' | 'voice' | 'video';
  filename?: string;
  robot_name?: string;
  video_title?: string;
  video_description?: string;
}

async function sendWecomMediaFromFile(args: SendWecomMediaArgs): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const abs = path.resolve(args.file_path);
  if (!fs.existsSync(abs)) {
    return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'file_not_found', detail: abs }) }] };
  }
  let stat: fs.Stats;
  try { stat = fs.statSync(abs); } catch (e) {
    return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'file_unreadable', detail: String(e) }) }] };
  }
  if (!stat.isFile()) {
    return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'not_a_file' }) }] };
  }
  const filename = args.filename || path.basename(abs);
  const buf = fs.readFileSync(abs);

  const headers: Record<string, string> = {
    'Content-Type': 'application/octet-stream',
    'Content-Length': String(buf.length),
    'X-Target-User': args.target_user,
    'X-Media-Type': args.media_type,
    'X-Filename': encodeURIComponent(filename),
    'X-Cc-Id': args.cc_id,  // v3.2.5: daemon 用 ccId 查 registry 找到正确的 robot（群聊必须用 CC 自己的机器人）
  };
  if (MCP_AUTH_TOKEN) headers['Authorization'] = `Bearer ${MCP_AUTH_TOKEN}`;
  if (args.robot_name) headers['X-Robot'] = args.robot_name;
  if (args.video_title) headers['X-Video-Title'] = encodeURIComponent(args.video_title);
  if (args.video_description) headers['X-Video-Description'] = encodeURIComponent(args.video_description);

  try {
    const res = await fetch(`${MCP_URL}/api/v1/wecom/send_media`, { method: 'POST', headers, body: buf });
    const text = await res.text();
    if (!res.ok) {
      return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'http_failed', status: res.status, body: text.slice(0, 500) }) }] };
    }
    return { content: [{ type: 'text', text }] };
  } catch (e) {
    return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'network_failed', detail: String(e) }) }] };
  }
}

async function uploadFileToHttp(args: UploadArgs): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const abs = path.resolve(args.file_path);
  if (!fs.existsSync(abs)) {
    return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'file_not_found', detail: abs }) }] };
  }
  let stat: fs.Stats;
  try { stat = fs.statSync(abs); } catch (e) {
    return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'file_unreadable', detail: String(e) }) }] };
  }
  if (!stat.isFile()) {
    return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'not_a_file' }) }] };
  }
  const title = args.title || path.basename(abs);
  const mime = args.mime_type || MIME_BY_EXT[path.extname(abs).toLowerCase()] || 'application/octet-stream';
  const buf = fs.readFileSync(abs);

  const endpoint = args.kind === 'document' ? '/api/v1/upload/document' : '/api/v1/upload/shared';
  const headers: Record<string, string> = {
    'Content-Type': 'application/octet-stream',
    'Content-Length': String(buf.length),
    'X-Title': encodeURIComponent(title),
    'X-Mime': mime,
  };
  if (MCP_AUTH_TOKEN) headers['Authorization'] = `Bearer ${MCP_AUTH_TOKEN}`;
  if (args.ttl_seconds) headers['X-TTL'] = String(args.ttl_seconds);
  if (args.kind === 'document') {
    headers['X-From-CC'] = args.cc_id;
    headers['X-To-CC'] = args.to_cc || '';
  } else {
    headers['X-Owner-CC'] = args.cc_id;
    if (args.tags && args.tags.length > 0) headers['X-Tags'] = args.tags.join(',');
  }

  try {
    const res = await fetch(`${MCP_URL}${endpoint}`, { method: 'POST', headers, body: buf });
    const text = await res.text();
    if (!res.ok) {
      return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'upload_http_failed', status: res.status, body: text.slice(0, 500) }) }] };
    }
    return { content: [{ type: 'text', text }] };
  } catch (e) {
    return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'upload_network_failed', detail: String(e) }) }] };
  }
}

interface DownloadArgs {
  kind: 'document' | 'shared';
  cc_id: string;
  id: string;
  save_path: string;
}

async function downloadFileFromHttp(args: DownloadArgs): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const savePath = path.resolve(args.save_path);
  const endpoint = args.kind === 'document'
    ? `/api/v1/download/document/${encodeURIComponent(args.id)}?cc=${encodeURIComponent(args.cc_id)}`
    : `/api/v1/download/shared/${encodeURIComponent(args.id)}`;
  const headers: Record<string, string> = {};
  if (MCP_AUTH_TOKEN) headers['Authorization'] = `Bearer ${MCP_AUTH_TOKEN}`;

  try {
    const res = await fetch(`${MCP_URL}${endpoint}`, { method: 'GET', headers });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'download_http_failed', status: res.status, body: text.slice(0, 500) }) }] };
    }
    const arrayBuf = await res.arrayBuffer();
    const buf = Buffer.from(arrayBuf);
    const dir = path.dirname(savePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(savePath, buf);
    const stat = fs.statSync(savePath);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          ok: true,
          saved_path: savePath,
          size: stat.size,
          mime_type: res.headers.get('content-type') || undefined,
        }),
      }],
    };
  } catch (e) {
    return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'download_network_failed', detail: String(e) }) }] };
  }
}

// 构建带 auth 的 fetch headers
function getAuthHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  if (MCP_AUTH_TOKEN) {
    headers['Authorization'] = `Bearer ${MCP_AUTH_TOKEN}`;
  }
  return headers;
}

// Channel 日志文件
/**
 * 写入 Channel 日志
 *
 * 默认走 logger.debug（仅 --debug 时落盘）。关键事件请直接调用 logger.info()，
 * 它们会永久落盘到 ~/.wecom-aibot-mcp/channel.log（自动滚动）。
 */
function logChannel(message: string, data?: any): void {
  logger.debug(message, data);
}

// SSE 连接状态
let sseConnected = false;
let sseAbortController: AbortController | null = null;
let mcpServer: McpServer | null = null;
let sseCurrentCcId: string | undefined = undefined;

// 保存首次 enter_headless_mode 的参数，重连时原样复用
let sseRobotId: string | undefined = undefined;
let sseProjectDir: string | undefined = undefined;

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
  logger.info('Connecting to SSE', { url: sseUrl, ccId, mcpServerReady: mcpServer ? 'yes' : 'no' });

  sseAbortController = new AbortController();
  // Watchdog：每 15s 检查最后一次收到 chunk 的时间，>45s 无数据则主动 abort 触发重连。
  // 修复 daemon 端 SSE keep-alive 单向失效问题（NAT 在 client→daemon 方向闭合时
  // daemon 写心跳失败把 entry 清掉，但 channel-server 的 fetch read 永不返回）。
  let watchdogTimer: NodeJS.Timeout | null = null;
  const clearWatchdog = () => {
    if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null; }
  };

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
      // server 重启后 ccId 注册丢失（404），需重新注册再重连
      if (!sseAbortController?.signal.aborted) {
        const delay = res.status === 404 ? 5000 : 3000;
        logChannel(`SSE 连接失败(${res.status})，${delay / 1000} 秒后重连`, { ccId });
        setTimeout(async () => {
          httpSessionId = null;  // 重置 session，防止使用 server 重启前的旧 session
          if (ccId) {
            // 重新调 enter_headless_mode 恢复 server 端 ccId 注册
            await forwardToHttpMcp('enter_headless_mode', {
              cc_id: ccId,
              robot_id: sseRobotId,
              mode: 'channel',
              project_dir: sseProjectDir || process.cwd(),
            }).catch((e) => logChannel('重注册 ccId 失败', { error: String(e) }));
          }
          connectSSE(ccId);
        }, delay);
      }
      return;
    }

    logger.info('SSE connected', { ccId, status: res.status });

    const reader = res.body?.getReader();
    if (!reader) {
      logChannel('No response body');
      sseConnected = false;
      return;
    }

    const decoder = new TextDecoder();
    let buffer = '';
    let messageCount = 0;
    let lastChunkAt = Date.now();
    let currentEvent = 'message';  // SSE event type，由 `event: xxx` 行设置；空行复位

    // Watchdog：>45s 没收到任何 chunk（含 daemon 端的 `: heartbeat` 注释）
    // 视为单向 TCP 死链，主动 abort 让 catch 分支触发 reconnect。
    watchdogTimer = setInterval(() => {
      const idleMs = Date.now() - lastChunkAt;
      logChannel('SSE watchdog', { connected: sseConnected, messages: messageCount, idleMs });
      if (idleMs > 45000) {
        logger.info('SSE 心跳超时（>45s 无数据），主动 abort 触发重连', { ccId, idleMs });
        try { sseAbortController?.abort(); } catch { /* ignore */ }
      }
    }, 15000);

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        logChannel('SSE stream ended');
        clearWatchdog();
        sseConnected = false;
        // 非主动断开时自动重连
        if (!sseAbortController?.signal.aborted) {
          logger.info('SSE 断线，3 秒后重连', { ccId });
          setTimeout(() => { httpSessionId = null; connectSSE(ccId); }, 3000);
        }
        break;
      }

      lastChunkAt = Date.now();
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
          logChannel('📩 SSE MESSAGE RECEIVED', { data: data.slice(0, 100), event: currentEvent });
          try {
            const msg = JSON.parse(data);
            messageCount++;
            logChannel('✅ 消息解析成功', { messageNumber: messageCount, event: currentEvent, msg });

            if (mcpServer) {
              let notification;
              if (currentEvent === 'cc_message') {
                // CC 间消息：用 cc:<fromCc> 作为 source 前缀，便于 agent 区分非 wecom 来源
                const meta: Record<string, string> = {
                  source: `cc:${msg.fromCc || ''}`,
                  from_cc: msg.fromCc || '',
                  to_cc: msg.toCc || '',
                  chattype: 'cc',
                  cc_id: msg.toCc || '',
                  kind: msg.kind || 'notify',
                  reply_to: msg.replyTo || '',
                  msg_id: msg.msgId || '',
                };
                if (Array.isArray(msg.attachments) && msg.attachments.length > 0) {
                  meta.attachments_json = JSON.stringify(msg.attachments);
                  meta.attachment_count = String(msg.attachments.length);
                }
                notification = {
                  method: 'notifications/claude/channel',
                  params: {
                    content: msg.content || '',
                    meta,
                  },
                };
              } else if (currentEvent === 'cc_document_notify') {
                // CC 间文档通知：只含元数据，agent 收到后按需 fetch_document(doc_id)
                const sizeKb = Math.max(1, Math.round((msg.size || 0) / 1024));
                const text = `📎 收到文档「${msg.title || ''}」(${msg.mimeType || ''}, ~${sizeKb} KB)，发送方=${msg.fromCc || ''}，docId=${msg.docId || ''}。调用 fetch_document(cc_id, doc_id="${msg.docId || ''}") 取内容。`;
                notification = {
                  method: 'notifications/claude/channel',
                  params: {
                    content: text,
                    meta: {
                      source: `cc:${msg.fromCc || ''}`,
                      from_cc: msg.fromCc || '',
                      to_cc: msg.toCc || '',
                      chattype: 'cc',
                      cc_id: msg.toCc || '',
                      kind: 'document',
                      doc_id: msg.docId || '',
                      title: msg.title || '',
                      mime_type: msg.mimeType || '',
                      size: String(msg.size || 0),
                      expires_at: String(msg.expiresAt || 0),
                    } as Record<string, string>,
                  },
                };
              } else {
                // 默认 wecom 消息（event: message 或无 event 头）
                const message = msg.message || {};
                notification = {
                  method: 'notifications/claude/channel',
                  params: {
                    content: message.content || JSON.stringify(msg),
                    meta: {
                      msgid: message.msgid || '',
                      from: message.from || '',
                      chatid: message.chatid || '',
                      chattype: message.chattype || 'single',
                      cc_id: msg.ccId || '',
                      quote_content: message.quoteContent || '',
                    } as Record<string, string>,
                  },
                };
              }
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
          currentEvent = line.slice(7).trim();
          logChannel('SSE event type', { type: currentEvent });
        } else if (line === '') {
          // 事件分隔符：复位 event type 到默认 'message'
          currentEvent = 'message';
        } else if (line.startsWith(':')) {
          // SSE 注释（如 ": heartbeat"），忽略，不要写回 buffer
        } else {
          // 可能是跨行 JSON 的一部分
          buffer = line;
        }
      }
    }

    clearWatchdog();
  }).catch((err) => {
    clearWatchdog();
    logger.error('SSE error', { error: String(err) });
    sseConnected = false;
    // watchdog abort 或网络异常都走这里：触发 reconnect
    // 注意 abort() 后 signal.aborted=true，但这是 watchdog 自己造成的，仍需要重连
    const isWatchdogAbort = sseAbortController?.signal.aborted && String(err).includes('aborted');
    if (!sseAbortController?.signal.aborted || isWatchdogAbort) {
      logger.info('SSE 出错，3 秒后重连', { ccId, watchdogAbort: isWatchdogAbort });
      // watchdog abort 后需要新建 controller，否则下次 connectSSE 会立即被 abort 状态干扰
      sseAbortController = null;
      setTimeout(() => { httpSessionId = null; connectSSE(ccId); }, 3000);
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
  // 工具 4a: CC 间通信 — send_to_cc / list_active_ccs（v2.6.0+）
  // ============================================
  server.tool(
    'send_to_cc',
    '向同一 daemon 上的另一个 CC 发送消息。目标 CC 收到时会作为 <channel source="cc:..."> 推送唤醒。仅支持同 daemon 间互通。支持 attachments 内联小文档（每个 < 16 KB）；大文档请改用 upload_document。',
    {
      cc_id: z.string().describe('自己的 CC 标识'),
      to_cc: z.string().describe('目标 CC 标识'),
      content: z.string().describe('消息内容（支持 Markdown）'),
      kind: z.enum(['request', 'reply', 'notify']).optional().default('notify').describe('消息语义'),
      reply_to: z.string().optional().describe('可选：关联的请求 msgId'),
      attachments: z.array(z.object({
        title: z.string(),
        content: z.string(),
        mimeType: z.string().optional(),
      })).optional().describe('可选：内联附件，每个 content < 16 KB'),
    },
    async (params) => forwardToHttpMcp('send_to_cc', params),
  );

  server.tool(
    'list_active_ccs',
    '列出同一 daemon 上当前在线的所有 CC',
    {
      cc_id: z.string().describe('自己的 CC 标识'),
    },
    async (params) => forwardToHttpMcp('list_active_ccs', params),
  );

  // ============================================
  // CC 间文档传输（v2.7.0+）— upload_document / fetch_document / list_documents
  // ============================================
  server.tool(
    'upload_document',
    'CC 间传输较大文档（> 16 KB 或二进制）。服务端暂存（默认 30 分钟 TTL），向目标 CC 推送 cc_document_notify 事件，接收方按需 fetch_document(docId) 取内容。',
    {
      cc_id: z.string().describe('自己的 CC 标识'),
      to_cc: z.string().describe('目标 CC 标识'),
      title: z.string().describe('文档标题'),
      content: z.string().describe('文档内容。文本直接传字符串；二进制（图片、PDF 等）传 base64 并设 encoding=base64'),
      mime_type: z.string().optional().describe('MIME 类型，如 text/markdown / image/png'),
      encoding: z.enum(['utf8', 'base64']).optional().default('utf8').describe('内容编码'),
      ttl_seconds: z.number().int().min(60).max(86400).optional().describe('暂存秒数，默认 1800，最大 86400'),
    },
    async (params) => forwardToHttpMcp('upload_document', params),
  );

  server.tool(
    'fetch_document',
    '按 docId 拉取 CC 间暂存的文档内容。仅文档接收方（to_cc）可取。图片自动返回 MCP image content（Claude 可视觉识别）。',
    {
      cc_id: z.string().describe('自己的 CC 标识（必须 = 文档的 to_cc）'),
      doc_id: z.string().describe('文档 ID（从 cc_document_notify 或 list_documents 获得）'),
    },
    async (params) => forwardToHttpMcp('fetch_document', params),
  );

  server.tool(
    'list_documents',
    '列出当前 CC 收到的所有未过期文档元数据（不含 content）。',
    {
      cc_id: z.string().describe('自己的 CC 标识'),
      from_cc: z.string().optional().describe('可选：只列指定发送方的文档'),
      include_expired: z.boolean().optional().describe('是否包含已过期，默认 false'),
    },
    async (params) => forwardToHttpMcp('list_documents', params),
  );

  // ============================================
  // 共享文件池（v2.7.0+）— share_file / fetch_shared_file / list_shared_files
  // 与 upload_document 不同：无指定接收方，所有 CC 可见
  // ============================================
  server.tool(
    'share_file',
    '上传一个共享文件到 MCP 服务端，所有在线 CC 都可通过 fetch_shared_file 取用。支持 inline content 或 file_path（server 直读，避免大文件经 Claude context）。默认 5 MB / 30 分钟 TTL。',
    {
      cc_id: z.string().describe('自己的 CC 标识（owner）'),
      title: z.string().describe('文件标题'),
      content: z.string().optional().describe('二选一：内联内容'),
      file_path: z.string().optional().describe('二选一：server 端文件绝对路径（大文件用，避免走 Claude context）'),
      mime_type: z.string().optional().describe('MIME 类型；file_path 模式按扩展名推断'),
      encoding: z.enum(['utf8', 'base64']).optional().describe('content 模式下的编码；file_path 自动判定'),
      ttl_seconds: z.number().int().min(60).max(86400).optional().describe('暂存秒数，默认 1800'),
      tags: z.array(z.string()).optional().describe('可选标签'),
    },
    async (params) => forwardToHttpMcp('share_file', params),
  );

  server.tool(
    'fetch_shared_file',
    '按 fileId 拉取共享文件内容。任何在线 CC 都能取。图片自动返回 MCP image content（Claude 可视觉识别）。',
    {
      cc_id: z.string().describe('自己的 CC 标识'),
      file_id: z.string().describe('共享文件 ID'),
    },
    async (params) => forwardToHttpMcp('fetch_shared_file', params),
  );

  server.tool(
    'list_shared_files',
    '列出共享文件池中未过期的文件元数据（不含 content）。',
    {
      cc_id: z.string().describe('自己的 CC 标识'),
      owner: z.string().optional().describe('可选：按 owner 过滤'),
      tag: z.string().optional().describe('可选：按标签过滤'),
      include_expired: z.boolean().optional().describe('是否包含已过期，默认 false'),
    },
    async (params) => forwardToHttpMcp('list_shared_files', params),
  );

  // ============================================
  // 接收方落盘工具（v2.7.0+）
  // ============================================
  server.tool(
    'accept_document',
    '接受 upload_document 推来的文档：fetch 内容 + 落盘到 {projectDir}/received-file/。【强制】必须先通过 send_message 询问用户、得到肯定回复后才能调用。',
    {
      cc_id: z.string().describe('自己的 CC 标识'),
      doc_id: z.string().describe('文档 ID'),
      save_as: z.string().optional().describe('可选：自定义文件名'),
    },
    async (params) => forwardToHttpMcp('accept_document', params),
  );

  server.tool(
    'get_document_info',
    '查询单个文档的元数据（不返回 content）。与 fetch_document 同权限：仅 to_cc 可查。',
    {
      cc_id: z.string().describe('自己的 CC 标识（必须 = 文档的 to_cc）'),
      doc_id: z.string().describe('文档 ID'),
    },
    async (params) => forwardToHttpMcp('get_document_info', params),
  );

  server.tool(
    'delete_shared_file',
    '删除共享文件。仅 owner 可删。',
    {
      cc_id: z.string().describe('自己的 CC 标识（必须 = owner）'),
      file_id: z.string().describe('共享文件 ID'),
    },
    async (params) => forwardToHttpMcp('delete_shared_file', params),
  );

  server.tool(
    'delete_document',
    '删除点对点文档。fromCc 或 toCc 任一方可删。',
    {
      cc_id: z.string().describe('自己的 CC 标识（必须 = fromCc 或 toCc）'),
      doc_id: z.string().describe('文档 ID'),
    },
    async (params) => forwardToHttpMcp('delete_document', params),
  );

  server.tool(
    'get_shared_file_info',
    '查询单个共享文件的元数据（不返回 content）。共享池无权限校验，任何 CC 都可查。',
    {
      cc_id: z.string().describe('自己的 CC 标识'),
      file_id: z.string().describe('共享文件 ID'),
    },
    async (params) => forwardToHttpMcp('get_shared_file_info', params),
  );

  server.tool(
    'accept_shared_file',
    '【已废弃】仅本地 daemon 有效。远端 daemon 用 download_shared_file_to_path 替代。',
    {
      cc_id: z.string().describe('自己的 CC 标识'),
      file_id: z.string().describe('共享文件 ID'),
      save_as: z.string().optional().describe('可选：自定义文件名'),
    },
    async (params) => forwardToHttpMcp('accept_shared_file', params),
  );

  // ============================================
  // 发媒体给 wecom 用户（v3.2.4）
  // channel-server 本地读文件 + HTTP POST 字节流 → daemon uploadMedia + sendMediaMessage
  // ============================================
  server.tool(
    'send_image_to_wecom_user',
    '把本地图片发送给 wecom 用户。channel-server 读文件 + POST 字节流 → daemon 调用 wecom uploadMedia + sendMediaMessage。文件字节不经 LLM context。',
    {
      cc_id: z.string().describe('自己的 CC 标识（仅日志）'),
      target_user: z.string().describe('目标 wecom userid（单聊用户ID，群聊用群ID/chatid）'),
      file_path: z.string().describe('本地图片绝对路径（PNG/JPEG/GIF/WebP 等）'),
      filename: z.string().optional().describe('可选：发到 wecom 端显示的文件名'),
      robot_name: z.string().optional().describe('可选：指定通过哪个机器人发送'),
    },
    async (params) => sendWecomMediaFromFile({ ...params, media_type: 'image' }),
  );

  server.tool(
    'send_file_to_wecom_user',
    '把本地任意文件（PDF/zip/docx 等）发送给 wecom 用户。',
    {
      cc_id: z.string().describe('自己的 CC 标识'),
      target_user: z.string().describe('目标 wecom userid 或 chatid'),
      file_path: z.string().describe('本地文件绝对路径'),
      filename: z.string().optional().describe('可选：wecom 显示的文件名（默认用 basename）'),
      robot_name: z.string().optional().describe('可选：指定机器人'),
    },
    async (params) => sendWecomMediaFromFile({ ...params, media_type: 'file' }),
  );

  server.tool(
    'send_video_to_wecom_user',
    '把本地视频文件发送给 wecom 用户。',
    {
      cc_id: z.string().describe('自己的 CC 标识'),
      target_user: z.string().describe('目标 wecom userid 或 chatid'),
      file_path: z.string().describe('本地视频路径（MP4 等）'),
      filename: z.string().optional(),
      title: z.string().optional().describe('视频标题'),
      description: z.string().optional().describe('视频描述'),
      robot_name: z.string().optional(),
    },
    async ({ title, description, ...params }) => sendWecomMediaFromFile({ ...params, media_type: 'video', video_title: title, video_description: description }),
  );

  server.tool(
    'send_voice_to_wecom_user',
    '把本地语音文件发送给 wecom 用户（amr 格式优先；wecom 对其他格式可能拒绝）。',
    {
      cc_id: z.string().describe('自己的 CC 标识'),
      target_user: z.string().describe('目标 wecom userid 或 chatid'),
      file_path: z.string().describe('本地语音文件路径'),
      filename: z.string().optional(),
      robot_name: z.string().optional(),
    },
    async (params) => sendWecomMediaFromFile({ ...params, media_type: 'voice' }),
  );

  // ============================================
  // 文件直传工具（v3.2.0）—— channel-server 本地读写 + HTTP 直传
  // 解决远端 daemon 场景下 file_path/accept_* 不可用的 bug
  // 文件字节全程不经 LLM context
  // ============================================
  server.tool(
    'upload_document_from_file',
    'CC 间发送文件给目标 CC：channel-server 本地读取 file_path → HTTP POST 字节流到 daemon → 目标 CC 收 cc_document_notify。文件全程不经 LLM context。',
    {
      cc_id: z.string().describe('自己的 CC 标识'),
      to_cc: z.string().describe('目标 CC 标识'),
      file_path: z.string().describe('本地文件绝对路径（channel-server 进程能读到的路径）'),
      title: z.string().optional().describe('可选：文档标题（默认用文件名）'),
      mime_type: z.string().optional().describe('可选：MIME 类型（默认按扩展名推断）'),
      ttl_seconds: z.number().int().min(60).max(86400).optional().describe('暂存秒数，默认 1800'),
    },
    async ({ cc_id, to_cc, file_path, title, mime_type, ttl_seconds }) => {
      return uploadFileToHttp({ kind: 'document', cc_id, to_cc, file_path, title, mime_type, ttl_seconds });
    },
  );

  server.tool(
    'share_file_from_path',
    '共享本地文件到 daemon 共享池：channel-server 本地读取 file_path → HTTP POST 字节流到 daemon。文件全程不经 LLM context。',
    {
      cc_id: z.string().describe('自己的 CC 标识（owner）'),
      file_path: z.string().describe('本地文件绝对路径'),
      title: z.string().optional().describe('可选：文件标题（默认用文件名）'),
      mime_type: z.string().optional().describe('可选：MIME 类型'),
      ttl_seconds: z.number().int().min(60).max(86400).optional().describe('暂存秒数，默认 1800'),
      tags: z.array(z.string()).optional().describe('可选标签'),
    },
    async ({ cc_id, file_path, title, mime_type, ttl_seconds, tags }) => {
      return uploadFileToHttp({ kind: 'shared', cc_id, file_path, title, mime_type, ttl_seconds, tags });
    },
  );

  server.tool(
    'download_document_to_path',
    '下载点对点文档到本地路径：channel-server 从 daemon HTTP GET 字节流 → 写入本地 save_path。文件全程不经 LLM context。',
    {
      cc_id: z.string().describe('自己的 CC 标识（必须 = 文档的 to_cc）'),
      doc_id: z.string().describe('文档 ID'),
      save_path: z.string().describe('本地保存路径（绝对路径；目录会自动创建）'),
    },
    async ({ cc_id, doc_id, save_path }) => {
      return downloadFileFromHttp({ kind: 'document', cc_id, id: doc_id, save_path });
    },
  );

  server.tool(
    'download_shared_file_to_path',
    '下载共享文件到本地路径：channel-server 从 daemon HTTP GET 字节流 → 写入本地 save_path。文件全程不经 LLM context。',
    {
      cc_id: z.string().describe('自己的 CC 标识'),
      file_id: z.string().describe('共享文件 ID'),
      save_path: z.string().describe('本地保存路径（绝对路径；目录会自动创建）'),
    },
    async ({ cc_id, file_id, save_path }) => {
      return downloadFileFromHttp({ kind: 'shared', cc_id, id: file_id, save_path });
    },
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
      auto_approve_timeout: z.number().optional().default(600).describe('超时自动决策等待时间（秒，默认 600 即 10 分钟）'),
    },
    async ({ agent_name, cc_id, robot_id, project_dir, mode, auto_approve_timeout }) => {
      // 转发请求
      const result = await forwardToHttpMcp('enter_headless_mode', {
        agent_name,
        cc_id,
        robot_id,
        project_dir: project_dir || process.cwd(),
        mode,
        auto_approve_timeout,
      });

      // 拦截响应，提取 ccId，建立 SSE 连接
      if (result && typeof result === 'object' && 'content' in result) {
        const content = result.content as Array<{ type: string; text: string }>;
        if (content[0]?.text) {
          try {
            const parsed = JSON.parse(content[0].text);
            if (parsed.ccId) {
              logger.info('Got ccId, connecting SSE', { ccId: parsed.ccId, mode });
              // 保存连接参数供重连复用
              sseRobotId = robot_id || parsed.robotName;
              sseProjectDir = project_dir || process.cwd();
              connectSSE(parsed.ccId);

              // Channel 模式：在本地项目写入 PermissionRequest hook
              const localProjectDir = project_dir || process.cwd();
              const hookResult = addPermissionHook(localProjectDir);
              logger.info('本地 PermissionRequest hook 已写入', { path: hookResult.path, success: hookResult.success });

              // 注册 Claude TUI 的 PID（不能用 process.ppid，npx 部署时 ppid 是 npx 不是 Claude）
              // WECOM_TEST_NO_REGISTER=1 时跳过注册，防止集成测试污染宿主机 active-projects.json
              if (!process.env.WECOM_TEST_NO_REGISTER) {
                const startPid = process.ppid ?? process.pid;
                const claudePid = findClaudePid(startPid);
                registerActiveProject(claudePid, localProjectDir);
                logger.info('本地 active-projects 已注册', {
                  pid: claudePid,
                  rawPpid: startPid,
                  resolvedClaudePid: claudePid !== startPid,
                  projectDir: localProjectDir,
                });
              } else {
                logger.info('WECOM_TEST_NO_REGISTER=1，跳过 active-projects 注册', { projectDir: localProjectDir });
              }

              // 写入本地 wecom-aibot.json（远程 HTTP MCP 写在远端 fs，agent 本地需要自己落地）
              updateWechatModeConfig(localProjectDir, {
                wechatMode: true,
                robotName: parsed.robotName,
                ccId: parsed.ccId,
                mode: parsed.mode || mode,
                autoApproveTimeout: auto_approve_timeout,
              });
              logger.info('本地 wecom-aibot.json 已写入', { projectDir: localProjectDir, robotName: parsed.robotName, ccId: parsed.ccId });

              // 安装 skill 到本地（同上）
              const skillResult = installSkill(localProjectDir);
              logger.info('本地 skill 安装', { success: skillResult.success, skillUrl: skillResult.skillUrl });

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
        logger.info('SSE disconnected', { cc_id });
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
    ['create_wecom_doc', '新建企业微信在线文档或智能表格', {
      doc_type: z.number().int().describe('文档类型：3=文档，10=智能表格'),
      doc_name: z.string().describe('文档名称'),
      robot_name: z.string().optional().describe('指定机器人名称（多机器人时必填）'),
    }],
    ['get_wecom_doc_content', '获取企业微信在线文档内容（Markdown 格式）', {
      type: z.number().int().describe('内容格式：2=Markdown'),
      url: z.string().optional().describe('文档链接'),
      docid: z.string().optional().describe('文档 docid'),
      task_id: z.string().optional().describe('任务 ID（轮询时填写）'),
      robot_name: z.string().optional().describe('指定机器人名称（多机器人时必填）'),
    }],
    ['edit_wecom_doc_content', '编辑企业微信在线文档内容（Markdown 格式覆写）', {
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
    instructions: '企业微信消息通过 <channel> 标签推送。属性说明：from=发送者userid, chatid=会话ID(单聊=用户ID,群聊=群ID), chattype=single|group, cc_id=当前会话标识。【强制规则1·用户消息】daemon 已经代你给用户发了"💭 收到/听到了，正在处理..."回执，agent 不需要再发送 ack，**直接处理任务**，处理完后用 send_message(cc_id, "【完成】...", target_user=chatid) 报结果即可。【强制规则2·CC 间文档】收到 <channel kind="document"> 通知（cc_document_notify）时，禁止擅自落盘：1) 立即 send_message 告知用户（"CC <from_cc> 想发送文件「<title>」(<size>, <mime_type>)，是否接收？"），target_user 取当前 cc 的 chatid；2) 等用户明确肯定回复（是/接受/yes/同意等）；3) 同意后调 download_document_to_path(cc_id, doc_id, save_path) 落盘（save_path 推荐 {projectDir}/received-file/<title>，目录会自动创建）；4) 发送完成消息并附 saved_path；拒绝则忽略 doc_id 不调任何下载工具。共享池 share_file_from_path/download_shared_file_to_path 为 pull 模型，agent 主动决定，无需询问。【强制规则3·撤回消息】收到内容以 "⚠️ 用户撤回了" 开头的 channel 消息时：说明用户在企微撤回了刚才的指令，可能是发错了。立即**停止当前任务**，不要继续已发起的工具调用，发送 send_message(cc_id, "已收到撤回信号，当前任务已暂停，等待新指令。", target_user=chatid) 然后等待用户。【重要】发送/接收文件请用 *_from_file / *_to_path 系列（文件字节走 channel-server 本地 fs + HTTP，不进 LLM context）；旧的 upload_document/fetch_document/accept_document 仍可用但仅适合小内容（< 16KB），远端 daemon 部署下 accept_* 与 file_path 模式不可用。',
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