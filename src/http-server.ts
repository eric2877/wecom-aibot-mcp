/**
 * HTTP 服务模块
 *
 * 提供以下端点：
 * - POST /mcp - MCP Streamable HTTP endpoint
 * - POST /approve - 审批请求
 * - GET /approval_status/:taskId - 审批状态查询
 * - GET /health - 健康检查
 * - GET /state - 系统状态查询
 *
 * 架构：使用 ccId 直接管理，不使用 sessionId 业务层概念。
 * MCP 协议层的 sessionId 由 SDK 内部管理，不暴露给业务逻辑。
 */

import * as http from 'http';
import * as path from 'path';
import * as os from 'os';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { registerHeadlessTools } from './tools/headless.js';
import { registerMessagingTools } from './tools/messaging.js';
import { registerUtilsTools } from './tools/utils-tools.js';
import { getClient, getConnectionState, getAllConnectionStates, connectAllRobots } from './connection-manager.js';
import { getCcIdBinding } from './cc-registry.js';
import { subscribeWecomMessage, WecomMessage } from './message-bus.js';

// 固定端口
export const HTTP_PORT = 18963;

// Hook 脚本路径
export const HOOK_SCRIPT_PATH = path.join(os.homedir(), '.wecom-aibot-mcp', 'permission-hook.sh');

let httpServer: http.Server | null = null;
let startTime: number = 0;

// ============================================
// 活跃 CC 管理（基于 ccId，不使用 sessionId）
// ============================================

// 活跃的 ccId 列表（enter_headless_mode 时添加，exit 时移除）
const activeCcIds: Set<string> = new Set();

// 添加活跃 ccId（由 enter_headless_mode 调用）
export function registerActiveCcId(ccId: string): void {
  activeCcIds.add(ccId);
}

// 移除活跃 ccId（由 exit_headless_mode 调用）
export function unregisterActiveCcId(ccId: string): void {
  activeCcIds.delete(ccId);
}

// 检查是否有活跃的微信模式
export function hasActiveHeadlessSession(): boolean {
  return activeCcIds.size > 0;
}

// 获取第一个活跃的 ccId 信息（hook 使用，单 CC 场景）
export function getFirstActiveCcId(): { ccId: string; robotName: string } | null {
  for (const ccId of activeCcIds) {
    const binding = getCcIdBinding(ccId);
    if (binding) {
      return { ccId, robotName: binding.robotName };
    }
  }
  return null;
}

// 生成 ccId（基于序号，供调试端点使用）
let ccIdIndex = 0;
export function generateCcId(): string {
  ccIdIndex++;
  return `cc-${ccIdIndex}`;
}

// 推送微信消息到所有 MCP 客户端（通过 SSE）
export async function pushMessageToAllClients(robotName: string, message: {
  msgid: string;
  content: string;
  from_userid: string;
  chatid: string;
  chattype: 'single' | 'group';
  timestamp: number;
}): Promise<void> {
  if (transports.size === 0) {
    console.log('[http] 无活跃 MCP 连接，无法推送消息');
    return;
  }

  for (const [sessionId, entry] of transports) {
    try {
      await entry.server.server.notification({
        method: 'notifications/message',
        params: {
          level: 'info',
          data: JSON.stringify({
            type: 'wecom_message',
            robotName,
            message: {
              content: message.content,
              from: message.from_userid,
              chatid: message.chatid,
              chattype: message.chattype,
              time: new Date(message.timestamp).toISOString(),
            },
          }),
        },
      });
      console.log(`[http] 已推送消息到 MCP 连接 ${sessionId}`);
    } catch (err) {
      console.error(`[http] 推送到 MCP 连接 ${sessionId} 失败:`, err);
    }
  }
}

// 审批请求接口
export interface ApprovalRequest {
  tool_name: string;
  tool_input: Record<string, unknown>;
}

// 审批状态条目
interface ApprovalEntry {
  taskId: string;
  status: 'pending' | 'allow-once' | 'deny';
  timestamp: number;
  tool_name: string;
  tool_input: Record<string, unknown>;
  description: string;
  robotName: string;
  timer?: NodeJS.Timeout;
}

// 使用 Map 存储多个待处理审批（按 taskId 索引）
const pendingApprovals: Map<string, ApprovalEntry> = new Map();
const APPROVAL_TIMEOUT_MS = parseInt(process.env.APPROVAL_TIMEOUT_MS || '600000', 10);  // 默认 10 分钟

const VERSION = '1.2.0';

// Transport 和 Server 存储（MCP 协议层，由 SDK 管理 sessionId）
interface TransportEntry {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
}
const transports: Map<string, TransportEntry> = new Map();

// 初始化 MCP Server
function initMcpServer(): void {
  subscribeWecomMessage((msg: WecomMessage) => {
    handleWecomMessage(msg);
  });
}

// 创建新的 MCP Server 实例
function createMcpServerInstance(): McpServer {
  const server = new McpServer({
    name: 'wecom-aibot-mcp',
    version: VERSION,
  }, {
    capabilities: {
      logging: {},
    }
  });
  registerHeadlessTools(server);
  registerMessagingTools(server);
  registerUtilsTools(server);
  return server;
}

// 处理微信消息
function handleWecomMessage(msg: WecomMessage): void {
  if (activeCcIds.size === 0) {
    console.log('[http] 无活跃 ccId，跳过消息处理');
    return;
  }

  // 单 CC 模式：直接推送
  if (activeCcIds.size === 1) {
    pushMessageToAllClients(msg.robotName, {
      msgid: msg.msgid,
      content: msg.content,
      from_userid: msg.from_userid,
      chatid: msg.chatid,
      chattype: msg.chattype,
      timestamp: msg.timestamp,
    });
    return;
  }

  // 多 CC 模式：基于引用内容路由
  const targetCcId = extractCcIdFromQuote(msg.quoteContent);
  if (targetCcId && activeCcIds.has(targetCcId)) {
    console.log(`[http] 消息路由给 ${targetCcId}`);
    pushMessageToAllClients(msg.robotName, {
      msgid: msg.msgid,
      content: msg.content,
      from_userid: msg.from_userid,
      chatid: msg.chatid,
      chattype: msg.chattype,
      timestamp: msg.timestamp,
    });
  } else {
    // 多 CC 在线但无引用，发送提示
    sendNoReferencePrompt(msg);
  }
}

// 从引用内容提取 ccId
function extractCcIdFromQuote(quoteContent?: string): string | null {
  if (!quoteContent) return null;
  const match = quoteContent.match(/【(cc-\d+)】/);
  if (match) return match[1];
  return null;
}

// 无引用消息提示
async function sendNoReferencePrompt(msg: WecomMessage): Promise<void> {
  const binding = getCcIdBinding(msg.robotName);
  if (!binding) return;

  const client = await getClient(binding.robotName);
  if (!client) return;

  const onlineList = Array.from(activeCcIds)
    .map(id => `• ${id}`)
    .join('\n');

  const firstCcId = Array.from(activeCcIds)[0];
  const reply = `检测到多个 Claude Code 会话在线，请引用回复指明接收者。

当前在线：
${onlineList}

示例：引用【${firstCcId}】的消息后回复`;

  await client.sendText(reply);
}

export async function startHttpServer(
  port: number = HTTP_PORT
): Promise<void> {
  startTime = Date.now();

  initMcpServer();

  return new Promise((resolve, reject) => {
    httpServer = http.createServer(async (req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Mcp-Session-Id');
      res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');

      if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
      }

      const url = req.url || '/';

      // MCP endpoint
      if (url === '/mcp' || url.startsWith('/mcp?')) {
        try {
          const sessionId = req.headers['mcp-session-id'] as string | undefined;

          // GET 请求：建立 SSE 流
          if (req.method === 'GET') {
            if (!sessionId) {
              res.writeHead(405, { 'Content-Type': 'text/plain' });
              res.end('Method Not Allowed: Session ID required for SSE stream');
              return;
            }

            const entry = transports.get(sessionId);
            if (!entry) {
              res.writeHead(404, { 'Content-Type': 'text/plain' });
              res.end('Session not found');
              return;
            }

            await entry.transport.handleRequest(req, res);
            return;
          }

          // POST 请求
          if (req.method === 'POST') {
            // 已有 session
            if (sessionId && transports.has(sessionId)) {
              await transports.get(sessionId)!.transport.handleRequest(req, res);
              return;
            }

            // 读取请求体
            const body = await readRequestBody(req);
            let parsedBody;
            try {
              parsedBody = JSON.parse(body);
            } catch {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Invalid JSON' }));
              return;
            }

            // 初始化请求
            if (!sessionId && isInitializeRequest(parsedBody)) {
              const newServer = createMcpServerInstance();
              const newTransport = new StreamableHTTPServerTransport({
                sessionIdGenerator: () => `mcp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                onsessioninitialized: (sid) => {
                  console.log(`[http] MCP 连接初始化: ${sid}`);
                  transports.set(sid, { transport: newTransport, server: newServer });
                },
              });

              newTransport.onclose = () => {
                const sid = newTransport.sessionId;
                if (sid) {
                  console.log(`[http] MCP 连接关闭: ${sid}`);
                  transports.delete(sid);
                }
              };

              await newServer.connect(newTransport);
              await newTransport.handleRequest(req, res, parsedBody);
              return;
            }

            // 既没有 session 也不是初始化请求
            if (!sessionId) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({
                jsonrpc: '2.0',
                error: { code: -32000, message: 'Bad Request: Missing session ID' },
                id: null
              }));
              return;
            }

            // session 不存在
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              jsonrpc: '2.0',
              error: { code: -32001, message: 'Session not found' },
              id: null
            }));
            return;
          }
        } catch (err) {
          console.error('[http] MCP 请求处理失败:', err);
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: (err as Error).message }));
          }
        }
        return;
      }

      if (req.method === 'POST' && url === '/approve') {
        await handleApprovalRequest(req, res);
        return;
      }

      if (req.method === 'GET' && url.startsWith('/approval_status/')) {
        handleApprovalStatus(req, res, url);
        return;
      }

      if (req.method === 'GET' && url === '/health') {
        handleHealthCheck(req, res);
        return;
      }

      if (req.method === 'GET' && url === '/state') {
        handleStateQuery(req, res);
        return;
      }

      if (req.method === 'POST' && url === '/notify') {
        await handleNotify(req, res);
        return;
      }

      if (req.method === 'POST' && url === '/trigger_keepalive') {
        await handleTriggerKeepalive(req, res);
        return;
      }

      if (req.method === 'POST' && url === '/push_notification') {
        await handlePushNotification(req, res);
        return;
      }

      // 调试端点：手动进入 headless 模式
      if (req.method === 'POST' && url === '/debug/enter_headless') {
        const ccId = generateCcId();
        activeCcIds.add(ccId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'entered',
          ccId,
          message: '已进入 headless 模式（调试）'
        }));
        console.log(`[http] [DEBUG] 进入 headless 模式: ccId=${ccId}`);
        return;
      }

      // 调试端点：退出 headless 模式
      if (req.method === 'POST' && url === '/debug/exit_headless') {
        activeCcIds.clear();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'exited', message: '已退出 headless 模式（调试）' }));
        console.log(`[http] [DEBUG] 退出 headless 模式`);
        return;
      }

      // 调试端点：模拟断开指定机器人的连接
      if (req.method === 'POST' && url.startsWith('/debug/disconnect/')) {
        const robotName = decodeURIComponent(url.replace('/debug/disconnect/', ''));
        console.log(`[http] [DEBUG] 模拟断开机器人: ${robotName}`);
        const client = await getClient(robotName);
        if (client) {
          client.disconnect();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, message: `已断开机器人: ${robotName}，待发送消息保留` }));
        } else {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `机器人未找到: ${robotName}` }));
        }
        return;
      }

      // 调试端点：触发重连
      if (req.method === 'POST' && url.startsWith('/debug/reconnect/')) {
        const robotName = decodeURIComponent(url.replace('/debug/reconnect/', ''));
        console.log(`[http] [DEBUG] 触发重连机器人: ${robotName}`);
        const client = await getClient(robotName);
        if (client && client.isConnected()) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, message: `已重连机器人: ${robotName}` }));
        } else if (client) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: '重连失败' }));
        } else {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `机器人未找到: ${robotName}` }));
        }
        return;
      }

      // 调试端点：获取所有连接状态
      if (req.method === 'GET' && url === '/debug/connections') {
        const states = getAllConnectionStates();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ connections: states }, null, 2));
        return;
      }

      // 调试端点：获取活跃 ccId 列表
      if (req.method === 'GET' && url === '/debug/ccids') {
        const ccIdList = Array.from(activeCcIds).map(id => {
          const binding = getCcIdBinding(id);
          return { ccId: id, robotName: binding?.robotName };
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ activeCcIds: ccIdList }));
        return;
      }

      if (req.method === 'POST' && url === '/debug/sampling') {
        const body = await readRequestBody(req);
        const { message, maxTokens = 200 } = JSON.parse(body);

        if (transports.size === 0) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '无活跃 MCP 连接' }));
          return;
        }

        const [, entry] = [...transports.entries()][0];
        try {
          const result = await entry.server.server.createMessage({
            messages: [{ role: 'user', content: { type: 'text', text: message } }],
            maxTokens,
          });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ result }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: (err as Error).message }));
        }
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not Found' }));
    });

    httpServer.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        reject(new Error(`端口 ${port} 已被占用`));
      } else {
        reject(err);
      }
    });

    httpServer.listen(port, '127.0.0.1', async () => {
      console.log(`[http] MCP Server 已启动: http://127.0.0.1:${port}`);
      console.log(`[http] MCP endpoint: http://127.0.0.1:${port}/mcp`);

      await connectAllRobots();

      resolve();
    });
  });
}

export function stopHttpServer(): void {
  if (httpServer) {
    httpServer.close();
    httpServer = null;
    console.log('[http] HTTP Server 已停止');
  }
}

async function handleApprovalRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  try {
    const body = await readRequestBody(req);
    const request = JSON.parse(body) as ApprovalRequest & { ccId?: string; projectDir?: string };

    // 优先使用请求中的 ccId 路由（hook 传入），回退到第一个活跃 ccId
    let robotName: string | null = null;

    if (request.ccId) {
      const binding = getCcIdBinding(request.ccId);
      if (binding) {
        robotName = binding.robotName;
      }
    }

    if (!robotName) {
      const firstCc = getFirstActiveCcId();
      if (firstCc) {
        robotName = firstCc.robotName;
      } else {
        const states = getAllConnectionStates();
        const connectedRobot = states.find(s => s.connected);
        if (connectedRobot) {
          robotName = connectedRobot.robotName;
        }
      }
    }

    if (!robotName) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '未连接机器人，请先进入微信模式' }));
      return;
    }

    const client = await getClient(robotName);
    if (!client) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '未连接机器人，请先进入微信模式' }));
      return;
    }

    const { tool_name, tool_input } = request;
    let description = '';
    if (tool_name === 'Bash') {
      description = `执行命令: ${(tool_input?.command as string) || '(unknown)'}`;
    } else if (tool_name === 'Write' || tool_name === 'Edit') {
      description = `操作文件: ${(tool_input?.file_path as string) || '(unknown)'}`;
    } else {
      description = `工具: ${tool_name}`;
    }

    const title = `【待审批】${tool_name}`;
    const requestId = `hook_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const taskId = await client.sendApprovalRequest(title, description, requestId);

    console.log(`[http] 审批请求已发送: ${taskId} (机器人: ${robotName})`);

    const entry: ApprovalEntry = {
      taskId,
      status: 'pending',
      timestamp: Date.now(),
      tool_name,
      tool_input,
      description,
      robotName,
    };

    entry.timer = setTimeout(() => onApprovalTimeout(taskId), APPROVAL_TIMEOUT_MS);
    pendingApprovals.set(taskId, entry);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ taskId, status: 'pending' }));
  } catch (err) {
    console.error('[http] 审批请求处理失败:', err);
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: (err as Error).message }));
  }
}

async function onApprovalTimeout(taskId: string): Promise<void> {
  const entry = pendingApprovals.get(taskId);
  if (!entry || entry.status !== 'pending') return;

  const client = await getClient(entry.robotName);
  if (!client) {
    console.log(`[http] 审批超时但机器人未连接，保留审批等待重连: ${taskId}`);
    return;
  }

  const result = client.getApprovalResult(taskId);
  if (result === 'pending') {
    console.log(`[http] 审批超时，发送提醒: ${taskId}`);

    const waitTime = Math.floor((Date.now() - entry.timestamp) / 60000);
    await client.sendText(`【审批提醒】您有 ${waitTime} 分钟前的审批请求待处理\n${entry.description}\n\n请在企业微信中完成审批。`);

    entry.timer = setTimeout(() => onApprovalTimeout(taskId), APPROVAL_TIMEOUT_MS);
  } else {
    pendingApprovals.delete(taskId);
  }
}

function handleApprovalStatus(_req: http.IncomingMessage, res: http.ServerResponse, url: string): void {
  const taskId = url.replace('/approval_status/', '');

  const entry = pendingApprovals.get(taskId);
  if (entry) {
    getClient(entry.robotName).then(client => {
      if (client) {
        const result = client.getApprovalResult(taskId);
        if (result !== 'pending') {
          entry.status = result as 'allow-once' | 'deny';
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: result, result }));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'pending', result: 'pending' }));
      }
    });
    return;
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'pending', result: 'pending' }));
}

function handleHealthCheck(_req: http.IncomingMessage, res: http.ServerResponse): void {
  const state = getConnectionState();
  const hasActive = hasActiveHeadlessSession();

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    status: 'ok',
    uptime: Math.floor((Date.now() - startTime) / 1000),
    websocket: { connected: state.connected, robotName: state.robotName },
    headless: hasActive ? { mode: 'HEADLESS' } : { mode: 'NORMAL' },
  }, null, 2));
}

function handleStateQuery(_req: http.IncomingMessage, res: http.ServerResponse): void {
  const state = getConnectionState();
  const connections = getAllConnectionStates();

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    connection: state,
    activeCcIds: Array.from(activeCcIds).map(id => {
      const binding = getCcIdBinding(id);
      return { ccId: id, robotName: binding?.robotName };
    }),
    connections: connections.map(c => ({
      robotName: c.robotName,
      connected: c.connected,
      agentName: c.agentName,
    })),
  }, null, 2));
}

async function handleNotify(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  try {
    const body = await readRequestBody(req);
    const { title, message } = JSON.parse(body);

    const firstCc = getFirstActiveCcId();
    if (!firstCc) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '未连接机器人' }));
      return;
    }

    const client = await getClient(firstCc.robotName);
    if (!client) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '未连接机器人' }));
      return;
    }

    await client.sendText(`**${title}**\n\n${message}`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: (err as Error).message }));
  }
}

async function handlePushNotification(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  try {
    const body = await readRequestBody(req);
    const { method, params } = JSON.parse(body);

    if (transports.size === 0) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '无活跃 MCP 连接' }));
      return;
    }

    let sent = 0;
    for (const [, entry] of transports) {
      try {
        await entry.server.server.notification({
          method: method || 'notifications/message',
          params: params || {}
        });
        sent++;
      } catch (err) {
        console.error('[http] 推送通知失败:', err);
      }
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, method: method || 'notifications/message', connections: sent }));
  } catch (err) {
    console.error('[http] 推送通知失败:', err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: (err as Error).message }));
  }
}

async function handleTriggerKeepalive(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  try {
    const firstCc = getFirstActiveCcId();
    if (!firstCc) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '未在微信模式' }));
      return;
    }

    const client = await getClient(firstCc.robotName);
    if (!client) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '未连接机器人' }));
      return;
    }

    const clientPendingApprovals = client.getPendingApprovalsRecords();

    if (clientPendingApprovals.length === 0) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, message: '无待处理审批' }));
      return;
    }

    const now = Date.now();
    let sent = 0;
    for (const approval of clientPendingApprovals) {
      const waitTime = now - approval.timestamp;
      const minutes = Math.floor(waitTime / 60000);

      const message = `【审批提醒】您有 ${minutes} 分钟前的审批请求待处理（${approval.toolName || '未知操作'}），请尽快在企业微信中审批。`;
      const result = await client.sendText(message);
      if (result) sent++;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, sent, total: clientPendingApprovals.length }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: (err as Error).message }));
  }
}

function readRequestBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

export function cleanupPortFile(): void {
  console.log('[http] 使用固定端口:', HTTP_PORT);
}
