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
import * as https from 'https';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { fileURLToPath } from 'url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { registerTools } from './tools/index.js';
import { getClient, getConnectionState, getAllConnectionStates, connectAllRobots } from './connection-manager.js';
import { subscribeWecomMessage, WecomMessage } from './message-bus.js';
import { listAllRobots, VERSION, getAuthToken } from './config-wizard.js';
import { logger } from './logger.js';

// ESM 兼容的 __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 固定端口
export const HTTP_PORT = 18963;

// Hook 脚本路径
export const HOOK_SCRIPT_PATH = path.join(os.homedir(), '.wecom-aibot-mcp', 'permission-hook.sh');

let httpServer: http.Server | https.Server | null = null;
let startTime: number = 0;

// Session ID 生成器（MCP SSE 使用）
function generateSessionId(): string {
  return `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// 从 agentName 生成简化的 ccId 名称
function sanitizeAgentName(agentName: string): string {
  // 简化名称：移除特殊字符，限制长度
  return agentName.replace(/[^a-zA-Z0-9\u4e00-\u9fa5_-]/g, '').slice(0, 20);
}

// ccId 生成器（基于 agentName）- 自动避免冲突
export function generateCcId(agentName?: string): string {
  const base = agentName ? sanitizeAgentName(agentName) : 'cc';

  // 无冲突：直接使用
  if (!ccIdRegistry.has(base)) return base;

  // 有冲突：自动添加数字后缀（-2, -3, ...）
  for (let i = 2; i <= 99; i++) {
    const candidate = `${base}-${i}`;
    if (!ccIdRegistry.has(candidate)) return candidate;
  }

  // 兜底：使用时间戳保证唯一性
  return `${base}-${Date.now()}`;
}

// 推送微信消息到 MCP 客户端（通过 SSE notification）
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

// 推送微信消息到 SSE 客户端（Channel 模式，按 ccId 精准推送）
export async function pushMessageToSSEClient(robotName: string, message: {
  msgid: string;
  content: string;
  from_userid: string;
  chatid: string;
  chattype: 'single' | 'group';
  timestamp: number;
  quoteContent?: string;
}, targetCcId?: string): Promise<void> {
  // 推送给匹配的 SSE 客户端
  if (sseClients.size === 0) {
    logger.log('[http] 无 SSE 客户端连接，无法推送消息');
    return;
  }

  // 找到匹配的 SSE 客户端
  for (const [clientId, client] of sseClients) {
    // 按 ccId 匹配或广播给所有同机器人客户端
    if (targetCcId && client.ccId !== targetCcId) {
      continue;
    }
    if (client.robotName !== robotName) {
      continue;
    }

    try {
      const data = JSON.stringify({
        type: 'wecom_message',
        robotName,
        ccId: targetCcId || client.ccId,
        message: {
          content: message.content,
          from: message.from_userid,
          chatid: message.chatid,
          chattype: message.chattype,
          time: new Date(message.timestamp).toISOString(),
          quoteContent: message.quoteContent,
        },
      });
      client.res.write(`event: message\ndata: ${data}\n\n`);
      logger.log(`[http] SSE 推送成功: clientId=${clientId}, ccId=${targetCcId || client.ccId}`);
    } catch (err) {
      logger.error(`[http] SSE 推送失败: clientId=${clientId}`, err);
      sseClients.delete(clientId);
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
// CC 注册表：ccId → { robotName, agentName, mode, projectDir, lastOnline }
// ccId 是 CC 的唯一身份标识，与 SSE session 解耦
// mode: 'channel' = SSE 推送，'http' = 轮询
// ============================================
interface CCRegistryEntry {
  robotName: string;
  agentName?: string;
  mode?: 'channel' | 'http';  // 运行模式
  projectDir?: string;  // 项目目录路径（用于写入配置文件）
  lastOnline: number;   // 最后在线时间戳（ms），用于超时清理
}

const ccIdRegistry = new Map<string, CCRegistryEntry>();

// 超时阈值：30 分钟未活跃的 ccId 视为离线
const CCID_STALE_TIMEOUT = 30 * 60 * 1000;

// 清理超时的 ccId 条目
function cleanStaleCcIds(): void {
  const now = Date.now();
  for (const [id, entry] of ccIdRegistry) {
    if (now - entry.lastOnline > CCID_STALE_TIMEOUT) {
      ccIdRegistry.delete(id);
      logger.log(`[ccid] 清理超时条目: ${id} (离线 ${Math.round((now - entry.lastOnline) / 60000)} 分钟)`);
    }
  }
}

// 注册 ccId。重连场景（config 文件已存在）直接覆盖更新；
// 首次注册时先清理超时条目。始终返回 success=true，不做冲突拦截。
export function registerCcId(ccId: string, robotName: string, agentName?: string, mode?: 'channel' | 'http', projectDir?: string, isReconnect?: boolean): { success: boolean; ccId: string } {
  if (isReconnect || ccIdRegistry.has(ccId)) {
    // 重连：直接覆盖，更新 lastOnline
    logger.log(`[ccid] 重连: ${ccId} → ${robotName}`);
  } else {
    // 首次注册：先清理超时条目
    cleanStaleCcIds();
    logger.log(`[ccid] 注册: ${ccId} → ${robotName} (${agentName || 'unknown'}, mode: ${mode || 'http'})`);
  }
  ccIdRegistry.set(ccId, { robotName, agentName, mode, projectDir, lastOnline: Date.now() });
  return { success: true, ccId };
}

export function unregisterCcId(ccId: string): void {
  ccIdRegistry.delete(ccId);
  logger.log(`[ccid] 注销: ${ccId}`);
}

export function clearCcIdRegistry(): { cleared: number; entries: string[] } {
  const entries = Array.from(ccIdRegistry.keys());
  ccIdRegistry.clear();
  logger.log(`[ccid] 清空注册表: 共清理 ${entries.length} 条 (${entries.join(', ')})`);
  return { cleared: entries.length, entries };
}

export function getRobotByCcId(ccId: string): string | null {
  return ccIdRegistry.get(ccId)?.robotName || null;
}

export function getProjectDirByCcId(ccId: string): string | null {
  return ccIdRegistry.get(ccId)?.projectDir || null;
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
  createdAt: number;   // 写入时间，用于定时清理
  tool_name: string;
  tool_input: Record<string, unknown>;
  description: string;
  robotName: string;
  ccId?: string;
  projectDir?: string;  // 用于 h5 详情页展示
}

// 使用 Map 存储多个待处理审批（按 taskId 索引）
const pendingApprovals: Map<string, ApprovalEntry> = new Map();


// Transport 和 Server 存储（每个 session 一个）
interface TransportEntry {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
}
const transports: Map<string, TransportEntry> = new Map();

// ============================================
// Channel SSE 客户端（独立于 MCP session）
// 用于 Channel 模式的消息推送
// ============================================
interface SSEClient {
  res: http.ServerResponse;
  ccId: string;
  robotName: string;
}
const sseClients: Map<string, SSEClient> = new Map();  // clientId -> SSEClient

// 初始化 MCP Server（不再全局连接）
function initMcpServer(): void {
  // 订阅消息总线，实现 SSE 推送
  subscribeWecomMessage((msg: WecomMessage) => {
    handleWecomMessage(msg);
  });

  // 定时清理过期审批条目（每 5 分钟清理超过 15 分钟的条目）
  setInterval(() => {
    const cutoff = Date.now() - 15 * 60 * 1000;
    let cleaned = 0;
    for (const [id, entry] of pendingApprovals) {
      if (entry.createdAt < cutoff) {
        pendingApprovals.delete(id);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      logger.log(`[http] 定时清理过期审批: ${cleaned} 条`);
    }
  }, 5 * 60 * 1000);
}

// 创建新的 MCP Server 实例
function createMcpServerInstance(): McpServer {
  const server = new McpServer({
    name: 'wecom-aibot-mcp',
    version: VERSION,
  }, {
    capabilities: {
      logging: {},  // 支持服务端主动推送日志消息
      experimental: {
        'claude/channel': {},  // 支持 Channel 模式 SSE 推送
      },
    }
  });
  registerTools(server);
  return server;
}

// 处理微信消息（根据 mode 选择推送方式）
async function handleWecomMessage(msg: WecomMessage): Promise<void> {
  // 查找匹配的 CC（基于引用内容中的 ccId）
  const targetCcId = extractCcIdFromQuote(msg.quoteContent);

  // 优先检查 SSE 客户端（Channel 模式）
  // 先尝试精准匹配（有 targetCcId）
  if (targetCcId) {
    const entry = getCCRegistryEntry(targetCcId);
    if (entry?.mode === 'channel') {
      logger.log(`[http] Channel 模式精准匹配，SSE 推送给 ${targetCcId}`);
      await pushMessageToSSEClient(msg.robotName, {
        msgid: msg.msgid,
        content: msg.content,
        from_userid: msg.from_userid,
        chatid: msg.chatid,
        chattype: msg.chattype,
        timestamp: msg.timestamp,
        quoteContent: msg.quoteContent,
      }, targetCcId);
      return;
    }
  }

  // 检查 SSE 客户端数量（按 robotName）
  const matchingSseClients: Array<{ clientId: string; ccId: string }> = [];
  for (const [clientId, client] of sseClients) {
    if (client.robotName === msg.robotName) {
      matchingSseClients.push({ clientId, ccId: client.ccId });
    }
  }

  if (matchingSseClients.length > 0) {
    // 有 SSE 客户端连接
    if (matchingSseClients.length === 1) {
      // 单个 SSE 客户端，直接推送
      const { clientId, ccId } = matchingSseClients[0];
      logger.log(`[http] 单 SSE 客户端 ${clientId}，直接推送`);
      await pushMessageToSSEClient(msg.robotName, {
        msgid: msg.msgid,
        content: msg.content,
        from_userid: msg.from_userid,
        chatid: msg.chatid,
        chattype: msg.chattype,
        timestamp: msg.timestamp,
        quoteContent: msg.quoteContent,
      }, ccId);
      return;
    }

    // 多个 SSE 客户端，需要引用路由
    if (targetCcId) {
      // 有引用，精准推送
      const matched = matchingSseClients.find(c => c.ccId === targetCcId);
      if (matched) {
        logger.log(`[http] 多 SSE 客户端，引用匹配 ${targetCcId}，精准推送`);
        await pushMessageToSSEClient(msg.robotName, {
          msgid: msg.msgid,
          content: msg.content,
          from_userid: msg.from_userid,
          chatid: msg.chatid,
          chattype: msg.chattype,
          timestamp: msg.timestamp,
          quoteContent: msg.quoteContent,
        }, targetCcId);
        return;
      }
    }

    // 无引用，尝试按 from_userid 匹配（2v2 场景）
    const matchedCcId = findCcIdByTargetUserId(msg.from_userid);
    if (matchedCcId) {
      const matched = matchingSseClients.find(c => c.ccId === matchedCcId);
      if (matched) {
        logger.log(`[http] 多 SSE 客户端，按 from_userid 路由给 ${matchedCcId}`);
        await pushMessageToSSEClient(msg.robotName, {
          msgid: msg.msgid,
          content: msg.content,
          from_userid: msg.from_userid,
          chatid: msg.chatid,
          chattype: msg.chattype,
          timestamp: msg.timestamp,
          quoteContent: msg.quoteContent,
        }, matchedCcId);
        return;
      }
    }

    // 无法确定目标 CC，发送引用提示
    logger.log('[http] 多 SSE 客户端，无引用匹配，发送提示');
    await sendNoReferencePrompt(msg);
    return;
  }

  // 无 SSE 客户端，走 HTTP 模式 notification 推送
  if (transports.size === 0) {
    logger.log('[http] 无活跃 MCP session，跳过消息处理');
    return;
  }

  // HTTP 模式下检查是否有在线 CC（而非 subscriberCount，后者只对 Channel 模式有效）
  const ccCount = getCCCount();
  logger.log(`[http] 当前在线 CC 数: ${ccCount}`);

  if (ccCount === 0) {
    logger.log('[http] 无在线 CC，跳过消息处理');
    return;
  }

  if (ccCount === 1) {
    // 只有一个订阅者，直接广播（SSE 检查已在前面完成）
    logger.log('[http] 单订阅者 HTTP 模式，直接广播');
    for (const [sessionId, sessEntry] of transports) {
      try {
        await sessEntry.server.server.notification({
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
  logger.log(`[http] 多订阅者模式，目标 ccId: ${targetCcId || '无'}`);

  if (targetCcId) {
    // 有明确的 ccId 引用，广播给所有 session（订阅者会自己过滤）
    logger.log(`[http] 引用匹配 ${targetCcId}，广播消息`);
    for (const [sessionId, sessEntry] of transports) {
      try {
        await sessEntry.server.server.notification({
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
    // 无 ccId 引用，尝试按 from_userid 匹配（2v2 场景）
    const matchedCcId = findCcIdByTargetUserId(msg.from_userid);
    if (matchedCcId) {
      logger.log(`[http] 多订阅者模式，按 from_userid 路由给 ${matchedCcId}`);
      const matchedEntry = getCCRegistryEntry(matchedCcId);
      if (matchedEntry?.mode === 'channel') {
        // Channel 模式：SSE 推送
        await pushMessageToSSEClient(msg.robotName, {
          msgid: msg.msgid,
          content: msg.content,
          from_userid: msg.from_userid,
          chatid: msg.chatid,
          chattype: msg.chattype,
          timestamp: msg.timestamp,
          quoteContent: msg.quoteContent,
        }, matchedCcId);
      } else {
        // HTTP 模式：notification 推送
        for (const [sessionId, sessEntry] of transports) {
          try {
            await sessEntry.server.server.notification({
              method: 'notifications/message',
              params: {
                level: 'info',
                data: JSON.stringify({
                  type: 'wecom_message',
                  robotName: msg.robotName,
                  targetCcId: matchedCcId,
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
          } catch (err) {
            logger.error(`[http] 推送失败 session ${sessionId}:`, err);
          }
        }
      }
    } else {
      // 无法确定目标 CC，发送引用提示
      logger.log('[http] 无引用匹配，发送提示');
      await sendNoReferencePrompt(msg);
    }
  }
}

// 根据 from_userid 匹配 ccId（2v2 场景：每个用户对应一个 CC）
function findCcIdByTargetUserId(fromUserId: string): string | null {
  const allRobots = listAllRobots();
  for (const [ccId, entry] of ccIdRegistry) {
    const robot = allRobots.find(r => r.name === entry.robotName);
    if (robot && robot.targetUserId === fromUserId) {
      return ccId;
    }
  }
  return null;
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

  await client.sendText(reply, msg.chatid);  // 发送到原始会话（群聊或单聊）
}

export async function startHttpServer(
  _server: McpServer,
  port: number = HTTP_PORT,
  httpsConfig?: { certPath: string; keyPath: string }
): Promise<void> {
  startTime = Date.now();

  // 初始化 MCP Server
  initMcpServer();

  return new Promise((resolve, reject) => {
    const requestHandler = async (req: http.IncomingMessage, res: http.ServerResponse) => {
      // CORS 设置：HTTPS 模式收紧为 'null'，HTTP 本地模式宽松为 '*'
      const isPublicMode = !!httpsConfig;
      res.setHeader('Access-Control-Allow-Origin', isPublicMode ? 'null' : '*');
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

      // Auth token 校验（排除 /health 和 /approval/ 详情页，后者由浏览器直接访问）
      const authToken = getAuthToken();
      if (authToken && url !== '/health' && !url.startsWith('/approval/')) {
        const authHeader = req.headers['authorization'];
        if (authHeader !== `Bearer ${authToken}`) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized' }));
          return;
        }
      }

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

      if (req.method === 'GET' && url.startsWith('/approval/')) {
        handleApprovalDetail(req, res, url);
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

      // SSE endpoint for Channel 模式
      if (req.method === 'GET' && url.startsWith('/sse/')) {
        handleSSEConnect(req, res, url);
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

      if (req.method === 'POST' && url === '/admin/clean-cache') {
        const result = clearCcIdRegistry();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, ...result }));
        return;
      }

      // ============================================
      // 调试端点统一拦截
      // ============================================
      if (url.startsWith('/debug/')) {
        // 生产环境禁用所有 debug 端点
        if (process.env.NODE_ENV === 'production') {
          res.writeHead(404);
          res.end();
          return;
        }

        // debug/sampling 额外要求配置了 Auth Token
        if (url === '/debug/sampling' && !getAuthToken()) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'debug/sampling 需要配置 Auth Token' }));
          return;
        }
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

      // Skill 文件下载 endpoint（支持远程部署）
      if (req.method === 'GET' && url === '/skill') {
        const skillPath = path.join(__dirname, '..', 'skills', 'headless-mode', 'SKILL.md');
        if (fs.existsSync(skillPath)) {
          const content = fs.readFileSync(skillPath, 'utf-8');
          res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' });
          res.end(content);
          logger.log(`[http] Skill 文件已下载`);
        } else {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Skill 文件不存在' }));
          logger.error(`[http] Skill 文件不存在: ${skillPath}`);
        }
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

      // 调试端点：模拟发送微信消息（测试 SSE 推送）
      if (req.method === 'POST' && url === '/debug/test_message') {
        const body = await readRequestBody(req);
        const params = JSON.parse(body);
        const robotName = params.robotName || 'CC';
        const content = params.content || '测试消息';
        const ccId = params.ccId;

        // 模拟微信消息
        const testMsg: WecomMessage = {
          robotName,
          msgid: `test_${Date.now()}`,
          content,
          from_userid: 'TestUser',
          chatid: 'TestUser',
          chattype: 'single',
          timestamp: Date.now(),
          quoteContent: ccId ? `【${ccId}】` : undefined,  // 模拟引用指定 ccId
        };

        // 发布到消息总线
        logger.log(`[http] [DEBUG] 模拟发送微信消息: robotName=${robotName}, content=${content}, ccId=${ccId}`);
        handleWecomMessage(testMsg);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'sent', message: '测试消息已发送', ccId }));
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
    };

    // 根据是否有 HTTPS 配置创建对应的 server
    if (httpsConfig) {
      const cert = fs.readFileSync(httpsConfig.certPath, 'utf-8');
      const key = fs.readFileSync(httpsConfig.keyPath, 'utf-8');
      httpServer = https.createServer({ cert, key }, requestHandler);
    } else {
      httpServer = http.createServer(requestHandler);
    }

    httpServer.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        reject(new Error(`端口 ${port} 已被占用`));
      } else {
        reject(err);
      }
    });

    // HTTPS 模式绑定所有网卡（供远程客户端访问），HTTP 模式只绑本地
    const host = httpsConfig ? '0.0.0.0' : '127.0.0.1';
    const protocol = httpsConfig ? 'https' : 'http';

    httpServer.listen(port, host, async () => {
      logger.log(`[http] MCP Server 已启动: ${protocol}://${host}:${port}`);
      logger.log(`[http] MCP endpoint: ${protocol}://${host}:${port}/mcp (stateless mode)`);

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

    const { tool_name, tool_input, projectDir } = request;
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

    // 构建卡片"详情"链接的 base（同源，从本请求的 Host/scheme 推断）
    const scheme = (req.socket as { encrypted?: boolean }).encrypted ? 'https' : 'http';
    const host = req.headers.host || `127.0.0.1:${HTTP_PORT}`;
    const detailUrlBase = `${scheme}://${host}/approval`;

    const taskId = await client.sendApprovalRequest(
      title, description, requestId, undefined, tool_input, ccId, detailUrlBase
    );

    logger.log(`[http] 审批请求已发送: ${taskId} (机器人: ${robotName}) 详情页: ${detailUrlBase}/${taskId}`);

    // 存储审批并启动超时计时器
    const entry: ApprovalEntry = {
      taskId,
      status: 'pending',
      timestamp: Date.now(),
      createdAt: Date.now(),   // 写入时间，用于定时清理
      tool_name,
      tool_input,
      description,
      robotName,
      ccId,
      projectDir,
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

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function handleApprovalDetail(_req: http.IncomingMessage, res: http.ServerResponse, url: string): void {
  const taskId = url.replace('/approval/', '');
  const entry = pendingApprovals.get(taskId);

  const respondHtml = (status: number, body: string) => {
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(body);
  };

  if (!entry) {
    respondHtml(404, `<!doctype html><meta charset="utf-8"><title>审批不存在</title>
<body style="font-family:-apple-system,system-ui,sans-serif;padding:24px;color:#333">
<h2>审批已过期或不存在</h2>
<p>TaskID: <code>${escapeHtml(taskId)}</code></p>
<p>此条记录可能已被清理（用户已决策或超时）。</p>
</body>`);
    return;
  }

  const inputPretty = (() => {
    try { return JSON.stringify(entry.tool_input ?? {}, null, 2); }
    catch { return String(entry.tool_input); }
  })();

  const statusLabel = {
    'pending': '⏳ 待审批',
    'allow-once': '✅ 已允许',
    'deny': '❌ 已拒绝',
  }[entry.status] ?? entry.status;

  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>审批详情 · ${escapeHtml(entry.tool_name)}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
         max-width: 780px; margin: 0 auto; padding: 16px; color: #222; background: #f7f7f9; }
  h1 { font-size: 20px; margin: 8px 0 16px; }
  .meta { background: #fff; border-radius: 8px; padding: 12px 16px; margin-bottom: 12px;
          box-shadow: 0 1px 2px rgba(0,0,0,.04); }
  .meta .row { display: flex; padding: 4px 0; border-bottom: 1px dashed #eee; }
  .meta .row:last-child { border-bottom: none; }
  .meta .k { width: 96px; color: #888; flex-shrink: 0; }
  .meta .v { flex: 1; word-break: break-all; }
  pre { background: #fff; border-radius: 8px; padding: 12px 16px;
        overflow-x: auto; font-size: 13px; line-height: 1.5;
        box-shadow: 0 1px 2px rgba(0,0,0,.04); white-space: pre-wrap; word-break: break-all; }
  .tag { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 12px;
         background: #eef; color: #446; }
  footer { color: #aaa; font-size: 12px; text-align: center; margin-top: 16px; }
</style>
</head>
<body>
<h1>审批详情</h1>
<div class="meta">
  <div class="row"><div class="k">状态</div><div class="v">${statusLabel}</div></div>
  <div class="row"><div class="k">工具</div><div class="v"><span class="tag">${escapeHtml(entry.tool_name)}</span></div></div>
  <div class="row"><div class="k">概要</div><div class="v">${escapeHtml(entry.description)}</div></div>
  ${entry.projectDir ? `<div class="row"><div class="k">项目目录</div><div class="v">${escapeHtml(entry.projectDir)}</div></div>` : ''}
  ${entry.ccId ? `<div class="row"><div class="k">CC</div><div class="v">${escapeHtml(entry.ccId)}</div></div>` : ''}
  <div class="row"><div class="k">TaskID</div><div class="v"><code>${escapeHtml(taskId)}</code></div></div>
</div>
<h3>完整参数</h3>
<pre>${escapeHtml(inputPretty)}</pre>
<footer>此页面随审批记录自动过期清理 · 请回到企业微信卡片点击审批按钮</footer>
</body>
</html>`;

  respondHtml(200, html);
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
          // 延迟 5 分钟删除，给 Hook 最后一次轮询窗口
          setTimeout(() => {
            pendingApprovals.delete(taskId);
            logger.log(`[http] 审批条目已清理: taskId=${taskId}`);
          }, 5 * 60 * 1000);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: result, result }));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'pending', result: 'pending' }));
      }
    }).catch(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'pending', result: 'pending' }));
    });
    return;
  }

  // 未找到 → 返回 404，让 Hook 识别"审批已丢失"并退出
  logger.log(`[http] pendingApprovals 中未找到 taskId=${taskId}`);
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'taskId not found', taskId }));
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
      pendingApprovals.delete(taskId);   // 处理完立即删除
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
    sseClients: sseClients.size,  // Channel 模式客户端数
    ccIds: getOnlineCcIds(),  // 当前注册的 ccId
  }, null, 2));
}

// SSE 连接处理（Channel 模式）
function handleSSEConnect(req: http.IncomingMessage, res: http.ServerResponse, _url: string): void {
  const urlObj = new URL(req.url!, 'http://localhost');
  const targetCcId = decodeURIComponent(urlObj.pathname.replace('/sse/', ''));
  const requestCcId = urlObj.searchParams.get('ccId');  // 请求方声明的身份

  const entry = getCCRegistryEntry(targetCcId);
  if (!entry) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end(`CC ${targetCcId} not found`);
    return;
  }

  // 请求方 ccId 必须与目标 ccId 一致
  if (requestCcId && requestCcId !== targetCcId) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `无权订阅 ccId: ${targetCcId}` }));
    return;
  }

  const clientId = `${targetCcId}_${Date.now()}`;

  // 设置 SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });

  // 注册 SSE 客户端
  sseClients.set(clientId, {
    res,
    ccId: targetCcId,
    robotName: entry.robotName,
  });
  logger.log(`[http] SSE 客户端连接: clientId=${clientId}, ccId=${targetCcId}, robotName=${entry.robotName}`);

  // 发送连接确认
  res.write(`event: connected\ndata: {"clientId":"${clientId}","ccId":"${targetCcId}"}\n\n`);

  // 心跳机制：每 15 秒发送注释行保持连接活跃
  const heartbeatInterval = setInterval(() => {
    // SSE 注释行（以冒号开头）会被客户端忽略，但保持连接
    res.write(': heartbeat\n\n');
    logger.log(`[http] SSE 心跳发送: clientId=${clientId}`);
  }, 15000);

  // 处理客户端断开
  req.on('close', () => {
    clearInterval(heartbeatInterval);
    sseClients.delete(clientId);
    logger.log(`[http] SSE 客户端断开: clientId=${clientId}`);
  });
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

// push_notification 允许的 method 白名单
const PUSH_NOTIFICATION_ALLOWED_METHODS = new Set([
  'notifications/message',
  'notifications/progress',
  'notifications/resources/updated',
  'notifications/tools/list_changed',
]);

async function handlePushNotification(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  try {
    const body = await readRequestBody(req);
    const { method, params } = JSON.parse(body);

    // method 白名单校验
    const effectiveMethod = method || 'notifications/message';
    if (!PUSH_NOTIFICATION_ALLOWED_METHODS.has(effectiveMethod)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: `不允许的 method: ${effectiveMethod}`,
        allowed: Array.from(PUSH_NOTIFICATION_ALLOWED_METHODS),
      }));
      return;
    }

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
          method: effectiveMethod,
          params: params || {}
        });
        sent++;
      } catch (err) {
        logger.error(`[http] 推送到 session ${sessionId} 失败:`, err);
      }
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, method: effectiveMethod, sessions: sent }));
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