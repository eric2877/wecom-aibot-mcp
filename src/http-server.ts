/**
 * HTTP 服务模块
 *
 * 提供以下端点：
 * - POST /mcp - MCP Streamable HTTP endpoint
 * - POST /approve - 审批请求
 * - GET /approval_status/:taskId - 审批状态查询
 * - GET /health - 健康检查
 * - GET /state - 系统状态查询
 */

import * as http from 'http';
import * as path from 'path';
import * as os from 'os';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { WecomClient } from './client.js';
import { getAllClients, getStats } from './client-pool.js';
import { getAllHeadlessStates, loadHeadlessState } from './headless-state.js';

// 固定端口
export const HTTP_PORT = 18963;

// Hook 脚本路径（用于项目级配置）
export const HOOK_SCRIPT_PATH = path.join(os.homedir(), '.wecom-aibot-mcp', 'permission-hook.sh');

let httpServer: http.Server | null = null;
let startTime: number = 0;

// 审批请求接口
export interface ApprovalRequest {
  tool_name: string;
  tool_input: Record<string, unknown>;
  projectDir?: string;
}

// 审批状态存储（projectDir -> taskId -> status）
const approvalStatus = new Map<string, Map<string, string>>();

/**
 * 启动 HTTP 服务
 */
export async function startHttpServer(
  client: WecomClient,
  server: McpServer,
  port: number = HTTP_PORT
): Promise<void> {
  startTime = Date.now();

  // 创建 HTTP Transport
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => `session-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  });

  // 连接 MCP Server 到 HTTP Transport
  await server.connect(transport);

  return new Promise((resolve, reject) => {
    httpServer = http.createServer(async (req, res) => {
      // CORS headers
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

      if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
      }

      const url = req.url || '/';

      // MCP endpoint - 委托给 transport 处理
      // MCP Streamable HTTP 支持 POST 和 GET
      if (url === '/mcp' || url.startsWith('/mcp?')) {
        await transport.handleRequest(req, res);
        return;
      }

      // 审批接口（非阻塞）
      if (req.method === 'POST' && url === '/approve') {
        await handleApprovalRequest(req, res, client);
        return;
      }

      // 审批状态查询接口
      if (req.method === 'GET' && url.startsWith('/approval_status/')) {
        handleApprovalStatus(req, res, url, client);
        return;
      }

      // 健康检查
      if (req.method === 'GET' && url === '/health') {
        handleHealthCheck(req, res, client);
        return;
      }

      // 系统状态
      if (req.method === 'GET' && url === '/state') {
        handleStateQuery(req, res);
        return;
      }

      // 404
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not Found' }));
    });

    httpServer.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`[http] 端口 ${port} 已被占用`);
        reject(new Error(`端口 ${port} 已被占用`));
      } else {
        reject(err);
      }
    });

    httpServer.listen(port, '127.0.0.1', () => {
      console.log(`[http] MCP Server 已启动: http://127.0.0.1:${port}`);
      console.log(`[http] MCP endpoint: http://127.0.0.1:${port}/mcp`);
      resolve();
    });
  });
}

/**
 * 停止 HTTP 服务
 */
export function stopHttpServer(): void {
  if (httpServer) {
    httpServer.close();
    httpServer = null;
    console.log('[http] HTTP Server 已停止');
  }
}

/**
 * 处理审批请求（非阻塞）
 */
async function handleApprovalRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  defaultClient: WecomClient
): Promise<void> {
  try {
    const body = await readRequestBody(req);
    const request: ApprovalRequest = JSON.parse(body);

    // 获取对应的 client
    let client = defaultClient;
    const projectDir = request.projectDir;

    // 从 headless 状态获取 projectDir（如果未提供）
    if (!projectDir) {
      const state = loadHeadlessState();
      if (state) {
        request.projectDir = state.projectDir;
      }
    }

    // 查找 client
    if (projectDir) {
      const { getClient } = await import('./client-pool.js');
      const projectClient = getClient(projectDir);
      if (projectClient) {
        client = projectClient;
      }
    }

    if (!client.isConnected()) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'WebSocket 未连接' }));
      return;
    }

    // 构建审批描述
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
    const requestId = `hook_${Date.now()}`;

    // 发送审批请求
    const taskId = await client.sendApprovalRequest(title, description, requestId);

    // 存储审批状态
    const dir = projectDir || 'default';
    if (!approvalStatus.has(dir)) {
      approvalStatus.set(dir, new Map());
    }
    approvalStatus.get(dir)!.set(taskId, 'pending');

    console.log(`[http] 审批请求已发送: ${taskId}`);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ taskId, status: 'pending' }));
  } catch (err) {
    console.error('[http] 审批请求处理失败:', err);
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: (err as Error).message }));
  }
}

/**
 * 处理审批状态查询
 */
function handleApprovalStatus(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  url: string,
  defaultClient: WecomClient
): void {
  const taskId = url.replace('/approval_status/', '');

  // 优先检查默认客户端（单例）
  let result = defaultClient.getApprovalResult(taskId);

  // 如果默认客户端没有，检查 client-pool 中的客户端
  if (result === 'pending') {
    const clients = getAllClients();
    for (const client of clients) {
      const status = client.getApprovalResult(taskId);
      if (status !== 'pending') {
        result = status;
        break;
      }
    }
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: result, result: result === 'pending' ? undefined : result }));
}

/**
 * 处理健康检查
 */
function handleHealthCheck(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  defaultClient: WecomClient
): void {
  const stats = getStats();

  // 找到当前进程的 headless 状态
  const currentState = loadHeadlessState();

  const health = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: Math.floor((Date.now() - startTime) / 1000),
    components: {
      websocket: {
        status: defaultClient.isConnected() ? 'AUTHENTICATED' : 'DISCONNECTED',
        healthy: defaultClient.isConnected(),
      },
      httpServer: {
        status: 'RUNNING',
        healthy: true,
        port: HTTP_PORT,
      },
      clientPool: {
        totalClients: stats.totalClients,
        connectedClients: stats.connectedClients,
      },
    },
    headless: currentState ? {
      mode: 'HEADLESS',
      projectDir: currentState.projectDir,
      agentName: currentState.agentName,
      enteredAt: new Date(currentState.timestamp).toISOString(),
    } : {
      mode: 'NORMAL',
    },
    pendingApprovals: 0, // TODO: 从 client 获取
    pendingMessages: 0,  // TODO: 从 client 获取
  };

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(health, null, 2));
}

/**
 * 处理系统状态查询
 */
function handleStateQuery(
  _req: http.IncomingMessage,
  res: http.ServerResponse
): void {
  const stats = getStats();
  const headlessStates = getAllHeadlessStates();

  const state = {
    websocket: {
      connected: stats.connectedClients > 0,
      clients: stats.projects.map(p => ({
        projectDir: p.projectDir,
        connected: p.connected,
        defaultUser: p.defaultUser,
      })),
    },
    headless: {
      sessions: headlessStates.map(s => ({
        pid: s.pid,
        projectDir: s.state.projectDir,
        agentName: s.state.agentName,
        enteredAt: new Date(s.state.timestamp).toISOString(),
      })),
    },
  };

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(state, null, 2));
}

/**
 * 读取请求体
 */
function readRequestBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      resolve(body);
    });
    req.on('error', reject);
  });
}

/**
 * 清理端口文件（已废弃，保留端口文件用于调试）
 */
export function cleanupPortFile(): void {
  // 不再需要端口文件，固定端口
  console.log('[http] 使用固定端口:', HTTP_PORT);
}