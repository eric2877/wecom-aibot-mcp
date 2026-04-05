/**
 * HTTP 服务模块
 *
 * 提供以下端点：
 * - POST /mcp - MCP Streamable HTTP endpoint (stateless mode)
 * - POST /approve - 审批请求
 * - GET /approval_status/:taskId - 审批状态查询
 * - GET /health - 健康检查
 * - GET /state - 系统状态查询
 *
 * MCP 使用 stateless 模式：每个请求创建新的 transport 和 server 实例
 */

import * as http from 'http';
import * as path from 'path';
import * as os from 'os';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { WecomClient } from './client.js';
import { getAllClients, getStats } from './client-pool.js';
import { getAllHeadlessStates, loadHeadlessState } from './headless-state.js';
import { registerTools } from './tools/index.js';

// 固定端口
export const HTTP_PORT = 18963;

// Hook 脚本路径（用于项目级配置）
export const HOOK_SCRIPT_PATH = path.join(os.homedir(), '.wecom-aibot-mcp', 'permission-hook.sh');

let httpServer: http.Server | null = null;
let startTime: number = 0;

// 全局 WecomClient 引用（用于非 MCP 端点）
let globalClient: WecomClient;

// 审批请求接口
export interface ApprovalRequest {
  tool_name: string;
  tool_input: Record<string, unknown>;
  projectDir?: string;
}

// 审批状态条目（单例，只保存当前请求）
interface ApprovalEntry {
  taskId: string;
  status: 'pending' | 'allow-once' | 'deny';
  timestamp: number;
  tool_name: string;
  tool_input: Record<string, unknown>;
  projectDir?: string;
  description: string;
}

// 当前审批请求（单例）
let currentApproval: ApprovalEntry | null = null;

// 超时计时器
let approvalTimer: NodeJS.Timeout | null = null;

// 超时时间（毫秒）
const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;  // 10 分钟

// MCP Server 版本
const VERSION = '1.0.6';

/**
 * 创建 MCP Server 实例并注册工具
 */
function createMcpServer(): McpServer {
  const server = new McpServer({
    name: 'wecom-aibot-mcp',
    version: VERSION,
  });

  // 注册工具
  registerTools(server, globalClient);

  return server;
}

/**
 * 启动 HTTP 服务
 *
 * MCP 端点使用 stateless 模式：每个请求创建新的 transport 和 server
 */
export async function startHttpServer(
  client: WecomClient,
  _server: McpServer,  // 保留参数兼容，但不使用
  port: number = HTTP_PORT
): Promise<void> {
  startTime = Date.now();
  globalClient = client;  // 保存全局引用

  return new Promise((resolve, reject) => {
    httpServer = http.createServer(async (req, res) => {
      // CORS headers
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Mcp-Session-Id');

      if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
      }

      const url = req.url || '/';

      // MCP endpoint - stateless 模式：每个请求创建新的 server + transport
      if (url === '/mcp' || url.startsWith('/mcp?')) {
        let server: McpServer | null = null;
        try {
          // 创建新的 transport（stateless 模式）
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined,  // stateless mode
          });

          // 创建新的 server 实例
          server = createMcpServer();

          // 连接 server 到 transport
          await server.connect(transport);

          // 处理请求
          await transport.handleRequest(req, res);
        } catch (err) {
          console.error('[http] MCP 请求处理失败:', err);
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: (err as Error).message }));
          }
        } finally {
          // 释放资源
          if (server) {
            try {
              await server.close();
            } catch (e) {
              // ignore close errors
            }
          }
        }
        return;
      }

      // 审批接口（非阻塞）
      if (req.method === 'POST' && url === '/approve') {
        await handleApprovalRequest(req, res);
        return;
      }

      // 审批状态查询接口
      if (req.method === 'GET' && url.startsWith('/approval_status/')) {
        handleApprovalStatus(req, res, url);
        return;
      }

      // 健康检查
      if (req.method === 'GET' && url === '/health') {
        handleHealthCheck(req, res);
        return;
      }

      // 系统状态
      if (req.method === 'GET' && url === '/state') {
        handleStateQuery(req, res);
        return;
      }

      // 代审批简报通知
      if (req.method === 'POST' && url === '/notify') {
        await handleNotify(req, res);
        return;
      }

      // 设置智能代批开关
      if (req.method === 'POST' && url === '/set_auto_approve') {
        await handleSetAutoApprove(req, res);
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
      console.log(`[http] MCP endpoint: http://127.0.0.1:${port}/mcp (stateless mode)`);
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
 *
 * 核心逻辑：
 * - autoApprove=false（默认）：只转发微信，不存储，不计时
 * - autoApprove=true：存储 + 启动计时器 + 超时后代批
 */
async function handleApprovalRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  try {
    const body = await readRequestBody(req);
    const request: ApprovalRequest = JSON.parse(body);

    // 获取对应的 client
    let client = globalClient;
    let projectDir = request.projectDir;

    // 从 headless 状态获取 projectDir（如果未提供）
    if (!projectDir) {
      const state = loadHeadlessState();
      if (state) {
        projectDir = state.projectDir;
      }
    }

    // 查找 client
    if (projectDir) {
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
    const requestId = `hook_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    // 发送审批请求
    const taskId = await client.sendApprovalRequest(title, description, requestId);

    console.log(`[http] 审批请求已发送: ${taskId}`);

    // 检查 autoApprove 开关
    const headlessState = loadHeadlessState();

    if (!headlessState?.autoApprove) {
      // autoApprove=false（默认）：不存储，不计时
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ taskId, status: 'pending', autoApprove: false }));
      return;
    }

    // autoApprove=true：存储 + 启动计时器
    if (approvalTimer) {
      clearTimeout(approvalTimer);
      approvalTimer = null;
    }

    currentApproval = {
      taskId,
      status: 'pending',
      timestamp: Date.now(),
      tool_name,
      tool_input,
      projectDir,
      description,
    };

    approvalTimer = setTimeout(() => onApprovalTimeout(client), APPROVAL_TIMEOUT_MS);

    console.log(`[http] 已启动超时计时器: ${taskId} (${APPROVAL_TIMEOUT_MS / 1000}秒)`);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ taskId, status: 'pending', autoApprove: true }));
  } catch (err) {
    console.error('[http] 审批请求处理失败:', err);
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: (err as Error).message }));
  }
}

/**
 * 审批超时处理
 */
async function onApprovalTimeout(client: WecomClient): Promise<void> {
  if (!currentApproval) {
    return;
  }

  const entry = currentApproval;
  const taskId = entry.taskId;

  // 检查用户是否已响应
  let result = client.getApprovalResult(taskId);
  if (result === 'pending') {
    const clients = getAllClients();
    for (const c of clients) {
      const status = c.getApprovalResult(taskId);
      if (status !== 'pending') {
        result = status;
        break;
      }
    }
  }

  if (result !== 'pending') {
    currentApproval = null;
    approvalTimer = null;
    return;
  }

  // 执行智能代批
  const decision = smartAutoApprove(entry.tool_name, entry.tool_input, entry.projectDir);
  entry.status = decision;

  console.log(`[http] 超时智能代批: ${taskId} -> ${decision}`);

  // 发送简报
  const decisionText = decision === 'allow-once' ? '✅ 已自动允许' : '❌ 已自动拒绝';
  const reason = getDecisionReason(entry.tool_name, entry.tool_input, entry.projectDir);

  const brief = `【自动审批简报】
由于您长时间未响应（>10分钟），系统已代为处理：

${decisionText}
  • [${entry.tool_name}] ${entry.description}

理由：${reason}

如需调整，请回复指令。`;

  try {
    await client.sendText(brief);
    console.log(`[http] 已发送代批简报: ${taskId}`);
  } catch (err) {
    console.error('[http] 发送简报失败:', err);
  }

  approvalTimer = null;
}

/**
 * 获取决策原因
 */
function getDecisionReason(
  tool_name: string,
  tool_input: Record<string, unknown>,
  projectDir?: string
): string {
  if (tool_name === 'Bash') {
    const cmd = (tool_input?.command as string) || '';
    if (/\brm\s/.test(cmd) || /\brmdir\s/.test(cmd) || /\bunlink\s/.test(cmd)) {
      return '删除操作需人工确认';
    }
    if (projectDir && cmd.includes(projectDir)) {
      return '项目内操作，风险可控';
    }
    if (/^(npm|npx|git|node)\s/.test(cmd) || /^\.\//.test(cmd)) {
      return '项目内常见命令';
    }
    return '无法确认操作范围';
  }

  if (tool_name === 'Write' || tool_name === 'Edit') {
    const filePath = (tool_input?.file_path as string) || '';
    if (projectDir && filePath.startsWith(projectDir)) {
      return '项目内文件操作';
    }
    if (!filePath.startsWith('/')) {
      return '相对路径，假设在项目内';
    }
    return '项目外操作，需人工确认';
  }

  return '未知操作类型';
}

/**
 * 处理审批状态查询
 */
function handleApprovalStatus(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  url: string
): void {
  const taskId = url.replace('/approval_status/', '');

  // 检查当前请求（单例）
  if (currentApproval && currentApproval.taskId === taskId) {
    let result = globalClient.getApprovalResult(taskId);
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

    if (result !== 'pending') {
      currentApproval.status = result as 'allow-once' | 'deny';
      if (approvalTimer) {
        clearTimeout(approvalTimer);
        approvalTimer = null;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: result, result }));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: currentApproval.status, result: currentApproval.status === 'pending' ? undefined : currentApproval.status }));
    return;
  }

  // autoApprove=false 模式
  let result = globalClient.getApprovalResult(taskId);
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
 * 智能代批逻辑
 */
function smartAutoApprove(
  tool_name: string,
  tool_input: Record<string, unknown>,
  projectDir?: string
): 'allow-once' | 'deny' {
  if (tool_name === 'Bash') {
    const cmd = (tool_input?.command as string) || '';
    if (/\brm\s/.test(cmd) || /\brmdir\s/.test(cmd) || /\bunlink\s/.test(cmd)) {
      return 'deny';
    }
    if (projectDir && cmd.includes(projectDir)) {
      return 'allow-once';
    }
    if (/^(npm|npx|git|node)\s/.test(cmd) || /^\.\//.test(cmd)) {
      return 'allow-once';
    }
    return 'deny';
  }

  if (tool_name === 'Write' || tool_name === 'Edit') {
    const filePath = (tool_input?.file_path as string) || '';
    if (tool_input?.mode === 'delete') {
      return 'deny';
    }
    if (projectDir && filePath.startsWith(projectDir)) {
      return 'allow-once';
    }
    if (!filePath.startsWith('/')) {
      return 'allow-once';
    }
    return 'deny';
  }

  return 'deny';
}

/**
 * 处理健康检查
 */
function handleHealthCheck(
  _req: http.IncomingMessage,
  res: http.ServerResponse
): void {
  const stats = getStats();
  const currentState = loadHeadlessState();

  const health = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: Math.floor((Date.now() - startTime) / 1000),
    components: {
      websocket: {
        status: globalClient.isConnected() ? 'AUTHENTICATED' : 'DISCONNECTED',
        healthy: globalClient.isConnected(),
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
    pendingApprovals: 0,
    pendingMessages: 0,
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
 * 处理代审批简报通知
 */
async function handleNotify(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  try {
    const body = await readRequestBody(req);
    const { title, message, projectDir } = JSON.parse(body);

    let client = globalClient;
    if (projectDir) {
      const projectClient = getClient(projectDir);
      if (projectClient) {
        client = projectClient;
      }
    }

    const content = `**${title}**\n\n${message}`;
    await client.sendText(content);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true }));
  } catch (err) {
    console.error('[http] 发送通知失败:', err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: (err as Error).message }));
  }
}

/**
 * 处理设置智能代批开关
 */
async function handleSetAutoApprove(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  try {
    const body = await readRequestBody(req);
    const { enabled } = JSON.parse(body);

    const { setAutoApprove } = await import('./headless-state.js');
    const state = setAutoApprove(enabled);

    if (!state) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '未在 headless 模式' }));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      autoApprove: state.autoApprove,
    }));
  } catch (err) {
    console.error('[http] 设置 autoApprove 失败:', err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: (err as Error).message }));
  }
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
 * 清理端口文件（已废弃）
 */
export function cleanupPortFile(): void {
  console.log('[http] 使用固定端口:', HTTP_PORT);
}

/**
 * 获取 client by projectDir
 */
function getClient(projectDir: string): WecomClient | undefined {
  const { getClient } = require('./client-pool.js');
  return getClient(projectDir);
}