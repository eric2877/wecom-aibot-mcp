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
import { subscribeWecomMessage, WecomMessage, getSubscriberCount } from './message-bus.js';
import { logger } from './logger.js';

// 固定端口
export const HTTP_PORT = 18963;

// Hook 脚本路径
export const HOOK_SCRIPT_PATH = path.join(os.homedir(), '.wecom-aibot-mcp', 'permission-hook.sh');

let httpServer: http.Server | null = null;
let startTime: number = 0;

// Session ID 生成器（MCP SSE 使用）
function generateSessionId(): string {
  return `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
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
    logger.log('[http] 无活跃 session，无法推送消息');
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
      logger.log(`[http] 已推送消息到 session ${sessionId}`);
    } catch (err) {
      logger.error(`[http] 推送消息到 session ${sessionId} 失败:`, err);
    }
  }
}

// 审批请求接口
export interface ApprovalRequest {
  tool_name: string;
  tool_input: Record<string, unknown>;
  projectDir?: string;
  ccId?: string;
  robotName?: string;  // 从项目配置读取的机器人名称（优先级高于 ccId）
}

// ============================================
// CC 注册表：ccId → { robotName, agentName }
// ccId 是 CC 的唯一身份标识，只通过 exit_headless_mode 工具清理
// ============================================
interface CCRegistryEntry {
  robotName: string;
  agentName?: string;
}

const ccIdRegistry = new Map<string, CCRegistryEntry>();

export function registerCcId(ccId: string, robotName: string, agentName?: string): void {
  ccIdRegistry.set(ccId, { robotName, agentName });
  logger.log(`[ccid] 注册: ${ccId} → ${robotName} (${agentName || 'unknown'})`);
}

export function unregisterCcId(ccId: string): void {
  ccIdRegistry.delete(ccId);
  logger.log(`[ccid] 注销: ${ccId}`);
}

export function getRobotByCcId(ccId: string): string | null {
  return ccIdRegistry.get(ccId)?.robotName || null;
}

export function getCCRegistryEntry(ccId: string): CCRegistryEntry | null {
  return ccIdRegistry.get(ccId) || null;
}

export function getCCCount(): number {
  return ccIdRegistry.size;
}

export function getCCCountByRobot(robotName: string): number {
  let count = 0;
  for (const [, entry] of ccIdRegistry) {
    if (entry.robotName === robotName) count++;
  }
  return count;
}

// 获取所有在线 ccId 列表（用于多 CC 提示）
export function getOnlineCcIds(): string[] {
  return Array.from(ccIdRegistry.keys());
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
}

// 使用 Map 存储多个待处理审批（按 taskId 索引）
const pendingApprovals: Map<string, ApprovalEntry> = new Map();

const VERSION = '1.6.0';

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

// 消息消费计数器（用于检测未被消费的消息）- 已移至 message-bus.ts

// 处理微信消息（路由给对应的 Session）
async function handleWecomMessage(msg: WecomMessage): Promise<void> {
  if (transports.size === 0) {
    logger.log('[http] 无活跃 MCP session，跳过消息处理');
    return;
  }

  const subscriberCount = getSubscriberCount(msg.robotName);
  logger.log(`[http] 机器人 ${msg.robotName} 订阅数: ${subscriberCount}`);

  if (subscriberCount === 0) {
    logger.log('[http] 无订阅者，跳过消息处理');
    return;
  }

  if (subscriberCount === 1) {
    // 只有一个订阅者，直接广播给它（无需 ccId 检查）
    logger.log('[http] 单订阅者模式，直接广播');
    for (const [sessionId, entry] of transports) {
      try {
        await entry.server.server.notification({
          method: 'notifications/message',
          params: {
            level: 'info',
            data: JSON.stringify({
              type: 'wecom_message',
              robotName: msg.robotName,
              message: {
                content: msg.content,
                from: msg.from_userid,
                chatid: msg.chatid,
                chattype: msg.chattype,
                time: new Date(msg.timestamp).toISOString(),
                quoteContent: msg.quoteContent,
              },
            }),
          },
        });
        logger.log(`[http] 已推送消息到 session ${sessionId}`);
      } catch (err) {
        logger.error(`[http] 推送失败 session ${sessionId}:`, err);
      }
    }
    return;
  }

  // 多订阅者模式：检查 ccId 引用
  const targetCcId = extractCcIdFromQuote(msg.quoteContent);
  logger.log(`[http] 多订阅者模式，目标 ccId: ${targetCcId || '无'}`);

  if (targetCcId) {
    // 有明确的 ccId 引用，广播给所有 session（订阅者会自己过滤）
    logger.log(`[http] 引用匹配 ${targetCcId}，广播消息`);
    for (const [sessionId, entry] of transports) {
      try {
        await entry.server.server.notification({
          method: 'notifications/message',
          params: {
            level: 'info',
            data: JSON.stringify({
              type: 'wecom_message',
              robotName: msg.robotName,
              targetCcId,  // 标记目标 ccId
              message: {
                content: msg.content,
                from: msg.from_userid,
                chatid: msg.chatid,
                chattype: msg.chattype,
                time: new Date(msg.timestamp).toISOString(),
                quoteContent: msg.quoteContent,
              },
            }),
          },
        });
        logger.log(`[http] 已推送消息到 session ${sessionId} (目标: ${targetCcId})`);
      } catch (err) {
        logger.error(`[http] 推送失败 session ${sessionId}:`, err);
      }
    }
  } else {
    // 无 ccId 引用，发送提示
    logger.log('[http] 无引用匹配，发送提示');
    await sendNoReferencePrompt(msg);
  }
}

// 从引用内容提取 ccId（匹配任意格式）
function extractCcIdFromQuote(quoteContent?: string): string | null {
  if (!quoteContent) return null;
  const match = quoteContent.match(/【([^】]+)】/);
  return match ? match[1] : null;
}

// 无引用消息提示
async function sendNoReferencePrompt(msg: WecomMessage): Promise<void> {
  const client = await getClient(msg.robotName);
  if (!client) return;

  const onlineList = getOnlineCcIds();
  if (onlineList.length === 0) return;  // 没有 CC 在线，不发提示

  const reply = `检测到多个 Claude Code 会话在线，请引用回复指明接收者。

当前在线：
${onlineList.map(id => `• 【${id}】`).join('\n')}

示例：引用【${onlineList[0]}】的消息后回复`;

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
              logger.log('[http] GET /mcp: 无 session ID，返回 405');
              res.writeHead(405, { 'Content-Type': 'text/plain' });
              res.end('Method Not Allowed: Session ID required for SSE stream');
              return;
            }

            const entry = transports.get(sessionId);
            if (!entry) {
              logger.log(`[http] GET /mcp: session ${sessionId} not found`);
              res.writeHead(404, { 'Content-Type': 'text/plain' });
              res.end('Session not found');
              return;
            }

            logger.log(`[http] 建立 SSE 流: session ${sessionId}`);
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
                  logger.log(`[http] Session 初始化: ${sid}`);
                  transports.set(sid, { transport: newTransport, server: newServer });
                },
              });

              // 清理
              newTransport.onclose = () => {
                const sid = newTransport.sessionId;
                if (sid) {
                  logger.log(`[http] Session 关闭: ${sid}`);
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
          logger.error('[http] MCP 请求处理失败:', err);
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

      if (req.method === 'POST' && url.startsWith('/approval_timeout/')) {
        await handleApprovalTimeout(req, res, url);
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
        const ccId = `debug-${Date.now()}`;
        registerCcId(ccId, 'ClaudeCode', '调试用户');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'entered',
          ccId,
          message: '已进入 headless 模式（调试）'
        }));
        logger.log(`[http] [DEBUG] 进入 headless 模式: ccId: ${ccId}`);
        return;
      }

      // 临时调试端点：退出 headless 模式
      if (req.method === 'POST' && url === '/debug/exit_headless') {
        ccIdRegistry.clear();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'exited', message: '已退出 headless 模式（调试）' }));
        logger.log(`[http] [DEBUG] 退出 headless 模式`);
        return;
      }

      // 调试端点：模拟断开指定机器人的连接（不删除状态，保留待发送队列）
      if (req.method === 'POST' && url.startsWith('/debug/disconnect/')) {
        const robotName = decodeURIComponent(url.replace('/debug/disconnect/', ''));
        logger.log(`[http] [DEBUG] 模拟断开机器人: ${robotName}`);
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
        logger.log(`[http] [DEBUG] 触发重连机器人: ${robotName}`);
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
      logger.log(`[http] MCP Server 已启动: http://127.0.0.1:${port}`);
      logger.log(`[http] MCP endpoint: http://127.0.0.1:${port}/mcp (stateless mode)`);

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
    logger.log('[http] HTTP Server 已停止');
  }
}

async function handleApprovalRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  try {
    const body = await readRequestBody(req);
    const request: ApprovalRequest = JSON.parse(body);

    // 优先级：请求中的 robotName > ccId 映射 > 第一个已连接机器人
    let robotName: string | null = null;
    const { ccId, robotName: requestedRobotName } = request;

    if (requestedRobotName) {
      robotName = requestedRobotName;
      logger.log(`[http] 审批路由: 请求指定 robotName=${robotName}`);
    } else if (ccId) {
      robotName = getRobotByCcId(ccId);
      if (robotName) {
        logger.log(`[http] 审批路由: ccId=${ccId} → ${robotName}`);
      }
    }
    if (!robotName) {
      const states = getAllConnectionStates();
      const connectedRobot = states.find(s => s.connected);
      if (connectedRobot) {
        robotName = connectedRobot.robotName;
        logger.log(`[http] 审批路由: 回退到第一个已连接机器人 ${robotName}`);
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

    logger.log(`[http] 审批请求已发送: ${taskId} (机器人: ${robotName})`);

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

    pendingApprovals.set(taskId, entry);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ taskId, status: 'pending' }));
  } catch (err) {
    logger.error('[http] 审批请求处理失败:', err);
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: (err as Error).message }));
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

async function handleApprovalTimeout(req: http.IncomingMessage, res: http.ServerResponse, url: string): Promise<void> {
  const taskId = url.replace('/approval_timeout/', '');

  try {
    const body = await readRequestBody(req);
    const { result, reason } = JSON.parse(body);

    const entry = pendingApprovals.get(taskId);
    if (!entry) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '审批记录不存在' }));
      return;
    }

    const client = await getClient(entry.robotName);
    if (!client) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '机器人未连接' }));
      return;
    }

    // 设置审批结果并发送微信消息
    const success = client.setApprovalResult(taskId, result, reason);
    if (success) {
      entry.status = result as 'allow-once' | 'deny';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, taskId, result }));
    } else {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '设置失败（已解决或不存在）' }));
    }
  } catch (err) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: (err as Error).message }));
  }
}

function handleHealthCheck(_req: http.IncomingMessage, res: http.ServerResponse): void {
  const state = getConnectionState();
  const hasActiveSession = getCCCount() > 0;

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

    // 获取第一个活跃 CC 的 robotName
    const firstEntry = ccIdRegistry.values().next().value;
    if (!firstEntry) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '未连接机器人' }));
      return;
    }

    const client = await getClient(firstEntry.robotName);
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
        logger.error(`[http] 推送到 session ${sessionId} 失败:`, err);
      }
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, method: method || 'notifications/message', sessions: sent }));
  } catch (err) {
    logger.error('[http] 推送通知失败:', err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: (err as Error).message }));
  }
}

async function handleTriggerKeepalive(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  try {
    const firstEntry = ccIdRegistry.values().next().value;
    if (!firstEntry) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '未在微信模式' }));
      return;
    }

    const client = await getClient(firstEntry.robotName);
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
  logger.log('[http] 使用固定端口:', HTTP_PORT);
}