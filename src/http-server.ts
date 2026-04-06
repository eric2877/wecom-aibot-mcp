/**
 * HTTP 服务模块
 *
 * 提供以下端点：
 * - POST /mcp - MCP Streamable HTTP endpoint (stateful session mode)
 * - POST /approve - 审批请求
 * - GET /approval_status/:taskId - 审批状态查询
 * - GET /health - 健康检查
 * - GET /state - 系统状态查询
 *
 * v2.0 架构变更：
 * - 使用 Session 管理，不再使用 projectDir
 * - Session → robotName → WebSocket Connection
 */

import * as http from 'http';
import * as path from 'path';
import * as os from 'os';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { registerTools } from './tools/index.js';
import { getClient, getConnectionState, getAllConnectionStates, connectAllRobots } from './connection-manager.js';
import { subscribeWecomMessage, WecomMessage } from './message-bus.js';

// 固定端口
export const HTTP_PORT = 18963;

// Hook 脚本路径
export const HOOK_SCRIPT_PATH = path.join(os.homedir(), '.wecom-aibot-mcp', 'permission-hook.sh');

let httpServer: http.Server | null = null;
let startTime: number = 0;

// ============================================
// Session 管理（核心：一个 session 对应一个机器人连接）
// ============================================

interface SessionData {
  robotName: string;      // 当前使用的机器人名称
  agentName?: string;     // 智能体名称
  ccId: string;           // CC 唯一标识（服务端生成）
  createdAt: number;      // 创建时间
}

// Session 存储：sessionId → sessionData
const sessionStore = new Map<string, SessionData>();

// Session 序号计数器（用于生成 ccId）
let sessionIndex = 0;

// Session ID 生成器
function generateSessionId(): string {
  return `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// ccId 生成器（基于序号）
export function generateCcId(): string {
  sessionIndex++;
  return `cc-${sessionIndex}`;
}

// 设置 session 数据（enter_headless_mode 时调用）
export function setSessionData(sessionId: string, data: SessionData): void {
  sessionStore.set(sessionId, data);
}

// 获取 session 数据（供工具使用）
export function getSessionData(sessionId: string): SessionData | null {
  return sessionStore.get(sessionId) || null;
}

// 从 sessionId 获取 session 数据（兼容 undefined 参数）
export function getSessionDataById(sessionId: string | undefined): SessionData | null {
  if (!sessionId) return null;
  return sessionStore.get(sessionId) || null;
}

// 删除 session（exit_headless_mode 时调用）
export function deleteSession(sessionId: string): void {
  sessionStore.delete(sessionId);
}

// 检查是否有活跃的 headless session（hook 使用）
export function hasActiveHeadlessSession(): boolean {
  return sessionStore.size > 0;
}

// 获取第一个活跃的 session（hook 使用，单 session 场景）
export function getFirstActiveSession(): { sessionId: string; data: SessionData } | null {
  for (const [sessionId, data] of sessionStore) {
    return { sessionId, data };
  }
  return null;
}

// 根据 robotName 查找 session
export function findSessionByRobotName(robotName: string): string | null {
  for (const [sessionId, data] of sessionStore) {
    if (data.robotName === robotName) {
      return sessionId;
    }
  }
  return null;
}

// 推送微信消息到 MCP 客户端（通过 SSE）
export async function pushMessageToSession(robotName: string, message: {
  msgid: string;
  content: string;
  from_userid: string;
  chatid: string;
  chattype: 'single' | 'group';
  timestamp: number;
}): Promise<void> {
  // 推送给所有活跃的 session
  if (transports.size === 0) {
    console.log('[http] 无活跃 session，无法推送消息');
    return;
  }

  // 广播给所有连接的客户端
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
      console.log(`[http] 已推送消息到 session ${sessionId}`);
    } catch (err) {
      console.error(`[http] 推送消息到 session ${sessionId} 失败:`, err);
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

// Transport 和 Server 存储（每个 session 一个）
interface TransportEntry {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
}
const transports: Map<string, TransportEntry> = new Map();

// 初始化 MCP Server（不再全局连接）
function initMcpServer(): void {
  // 订阅消息总线，实现 SSE 推送
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
      logging: {},  // 支持服务端主动推送日志消息
    }
  });
  registerTools(server);
  return server;
}

// 处理微信消息（路由给对应的 Session）
function handleWecomMessage(msg: WecomMessage): void {
  if (transports.size === 0) {
    console.log('[http] 无活跃 MCP session，跳过消息处理');
    return;
  }

  // 查找匹配的 Session（基于引用内容中的 ccId）
  const targetSession = findSessionByCcId(msg.quoteContent);

  if (targetSession) {
    // 有引用，SSE 推送给对应的 CC
    console.log(`[http] 消息路由给 ${targetSession.ccId}`);
    pushMessageToSession(msg.robotName, {
      msgid: msg.msgid,
      content: msg.content,
      from_userid: msg.from_userid,
      chatid: msg.chatid,
      chattype: msg.chattype,
      timestamp: msg.timestamp,
    });
  } else if (sessionStore.size === 1) {
    // 只有一个 CC 在线，直接推送（无需引用）
    console.log(`[http] 单 CC 模式，直接推送`);
    pushMessageToSession(msg.robotName, {
      msgid: msg.msgid,
      content: msg.content,
      from_userid: msg.from_userid,
      chatid: msg.chatid,
      chattype: msg.chattype,
      timestamp: msg.timestamp,
    });
  } else if (sessionStore.size > 1) {
    // 多 CC 在线但无引用，发送提示
    console.log(`[http] 多 CC 模式，无引用，发送提示`);
    sendNoReferencePrompt(msg);
  }
}

// 从引用内容提取 ccId
function extractCcIdFromQuote(quoteContent?: string): string | null {
  if (!quoteContent) return null;
  // 匹配格式：【cc-1】或【cc-2】等
  const match = quoteContent.match(/【(cc-\d+)】/);
  if (match) {
    return match[1]; // 返回 ccId（如 cc-1）
  }
  return null;
}

// 根据 ccId 查找 Session
function findSessionByCcId(quoteContent?: string): SessionData | null {
  const ccId = extractCcIdFromQuote(quoteContent);
  if (!ccId) return null;

  for (const [, data] of sessionStore) {
    if (data.ccId === ccId) {
      return data;
    }
  }
  return null;
}

// 无引用消息提示
async function sendNoReferencePrompt(msg: WecomMessage): Promise<void> {
  const client = await getClient(msg.robotName);
  if (!client) return;

  const onlineList = Array.from(sessionStore.values())
    .map(s => `• ${s.ccId}`)
    .join('\n');

  const reply = `检测到多个 Claude Code 会话在线，请引用回复指明接收者。

当前在线：
${onlineList}

示例：引用【${Array.from(sessionStore.values())[0].ccId}】的消息后回复`;

  await client.sendText(reply);
}

export async function startHttpServer(
  _server: McpServer,
  port: number = HTTP_PORT
): Promise<void> {
  startTime = Date.now();

  // 初始化 MCP Server
  initMcpServer();

  return new Promise((resolve, reject) => {
    httpServer = http.createServer(async (req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Mcp-Session-Id');
      // 必须暴露 Mcp-Session-Id 头，让客户端能看到
      res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');

      if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
      }

      const url = req.url || '/';

      // MCP endpoint - 每个客户端一个独立的 server 和 transport
      // POST /mcp: 初始化或调用工具
      // GET /mcp: 建立 SSE 流
      if (url === '/mcp' || url.startsWith('/mcp?')) {
        try {
          const sessionId = req.headers['mcp-session-id'] as string | undefined;

          // GET 请求用于建立 SSE 流
          if (req.method === 'GET') {
            // 没有 session ID，返回 405 表示不支持匿名 SSE
            // 客户端会先发送 POST 初始化，然后带着 session ID 来 GET
            if (!sessionId) {
              console.log('[http] GET /mcp: 无 session ID，返回 405');
              res.writeHead(405, { 'Content-Type': 'text/plain' });
              res.end('Method Not Allowed: Session ID required for SSE stream');
              return;
            }

            const entry = transports.get(sessionId);
            if (!entry) {
              console.log(`[http] GET /mcp: session ${sessionId} not found`);
              res.writeHead(404, { 'Content-Type': 'text/plain' });
              res.end('Session not found');
              return;
            }

            console.log(`[http] 建立 SSE 流: session ${sessionId}`);
            await entry.transport.handleRequest(req, res);
            return;
          }

          // POST 请求
          if (req.method === 'POST') {
            // 已有 session
            if (sessionId && transports.has(sessionId)) {
              const entry = transports.get(sessionId)!;
              await entry.transport.handleRequest(req, res);
              return;
            }

            // 读取请求体判断是否为初始化请求
            const body = await readRequestBody(req);
            let parsedBody;
            try {
              parsedBody = JSON.parse(body);
            } catch {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Invalid JSON' }));
              return;
            }

            // 新的初始化请求
            if (!sessionId && isInitializeRequest(parsedBody)) {
              // 创建新的 server 和 transport
              const newServer = createMcpServerInstance();
              const newTransport = new StreamableHTTPServerTransport({
                sessionIdGenerator: generateSessionId,
                onsessioninitialized: (sid) => {
                  console.log(`[http] Session 初始化: ${sid}`);
                  transports.set(sid, { transport: newTransport, server: newServer });
                },
              });

              // 清理
              newTransport.onclose = () => {
                const sid = newTransport.sessionId;
                if (sid) {
                  console.log(`[http] Session 关闭: ${sid}`);
                  transports.delete(sid);
                  sessionStore.delete(sid);
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

      // 临时调试端点：手动进入 headless 模式
      if (req.method === 'POST' && url === '/debug/enter_headless') {
        const testSessionId = `test_session_${Date.now()}`;
        const ccId = generateCcId();
        setSessionData(testSessionId, {
          robotName: 'ClaudeCode',
          agentName: '调试用户',
          ccId,
          createdAt: Date.now(),
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'entered',
          sessionId: testSessionId,
          ccId,
          message: '已进入 headless 模式（调试）'
        }));
        console.log(`[http] [DEBUG] 进入 headless 模式: ${testSessionId}, ccId: ${ccId}`);
        return;
      }

      // 临时调试端点：退出 headless 模式
      if (req.method === 'POST' && url === '/debug/exit_headless') {
        sessionStore.clear();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'exited', message: '已退出 headless 模式（调试）' }));
        console.log(`[http] [DEBUG] 退出 headless 模式`);
        return;
      }

      // 调试端点：模拟断开指定机器人的连接（不删除状态，保留待发送队列）
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

      // 调试端点：触发重连（通过 getClient 自动重连）
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

      // 调试端点：获取所有连接状态（详细信息）
      if (req.method === 'GET' && url === '/debug/connections') {
        const states = getAllConnectionStates();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ connections: states }, null, 2));
        return;
      }

      if (req.method === 'POST' && url === '/debug/sampling') {
        const body = await readRequestBody(req);
        const { message, maxTokens = 200 } = JSON.parse(body);

        if (transports.size === 0) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '无活跃 MCP session' }));
          return;
        }

        const [sessionId, entry] = [...transports.entries()][0];
        try {
          const result = await entry.server.server.createMessage({
            messages: [{ role: 'user', content: { type: 'text', text: message } }],
            maxTokens,
          });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ sessionId, result }));
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
      console.log(`[http] MCP endpoint: http://127.0.0.1:${port}/mcp (stateless mode)`);

      // 自动连接所有配置的机器人
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
    const request: ApprovalRequest = JSON.parse(body);

    // 获取第一个活跃 session 或第一个已连接的机器人
    let robotName: string | null = null;
    const session = getFirstActiveSession();
    if (session && session.data.robotName) {
      robotName = session.data.robotName;
    } else {
      // 检查已连接的机器人（启动时自动连接的）
      const states = getAllConnectionStates();
      const connectedRobot = states.find(s => s.connected);
      if (connectedRobot) {
        robotName = connectedRobot.robotName;
      }
    }

    if (!robotName) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '未连接机器人，请先进入微信模式' }));
      return;
    }

    // 获取 client
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

    // 存储审批并启动超时计时器
    const entry: ApprovalEntry = {
      taskId,
      status: 'pending',
      timestamp: Date.now(),
      tool_name,
      tool_input,
      description,
      robotName,
    };

    // 启动超时计时器
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
    // 机器人未连接，保留审批条目等待重连
    console.log(`[http] 审批超时但机器人未连接，保留审批等待重连: ${taskId}`);
    return;
  }

  const result = client.getApprovalResult(taskId);
  if (result === 'pending') {
    // 超时发送提醒，不改变状态，继续等待
    console.log(`[http] 审批超时，发送提醒: ${taskId}`);

    const waitTime = Math.floor((Date.now() - entry.timestamp) / 60000);
    await client.sendText(`【审批提醒】您有 ${waitTime} 分钟前的审批请求待处理\n${entry.description}\n\n请在企业微信中完成审批。`);

    // 重新设置超时计时器（再等 10 分钟）
    entry.timer = setTimeout(() => onApprovalTimeout(taskId), APPROVAL_TIMEOUT_MS);
  } else {
    // 已有结果，清理条目
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
        // 更新审批状态
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

  // 没找到对应的待处理审批，返回 pending
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'pending', result: 'pending' }));
}

function handleHealthCheck(_req: http.IncomingMessage, res: http.ServerResponse): void {
  const state = getConnectionState();
  const hasActiveSession = hasActiveHeadlessSession();

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    status: 'ok',
    uptime: Math.floor((Date.now() - startTime) / 1000),
    websocket: { connected: state.connected, robotName: state.robotName },
    headless: hasActiveSession ? { mode: 'HEADLESS' } : { mode: 'NORMAL' },
  }, null, 2));
}

function handleStateQuery(_req: http.IncomingMessage, res: http.ServerResponse): void {
  const state = getConnectionState();
  const connections = getAllConnectionStates();

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    connection: state,
    sessions: connections.map(c => ({
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

    // 获取第一个活跃 session
    const session = getFirstActiveSession();
    if (!session) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '未连接机器人' }));
      return;
    }

    const client = await getClient(session.data.robotName);
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
      res.end(JSON.stringify({ error: '无活跃 MCP session' }));
      return;
    }

    // 向所有活跃 session 发送通知
    let sent = 0;
    for (const [sessionId, entry] of transports) {
      try {
        await entry.server.server.notification({
          method: method || 'notifications/message',
          params: params || {}
        });
        sent++;
      } catch (err) {
        console.error(`[http] 推送到 session ${sessionId} 失败:`, err);
      }
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, method: method || 'notifications/message', sessions: sent }));
  } catch (err) {
    console.error('[http] 推送通知失败:', err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: (err as Error).message }));
  }
}

async function handleTriggerKeepalive(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  try {
    const session = getFirstActiveSession();
    if (!session) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '未在微信模式' }));
      return;
    }

    const client = await getClient(session.data.robotName);
    if (!client) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '未连接机器人' }));
      return;
    }

    // 获取待处理审批
    const clientPendingApprovals = client.getPendingApprovalsRecords();

    if (clientPendingApprovals.length === 0) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, message: '无待处理审批' }));
      return;
    }

    // 发送保活消息
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