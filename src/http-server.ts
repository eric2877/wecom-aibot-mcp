/**
 * HTTP 服务模块
 *
 * 提供以下端点：
 * - POST /mcp - MCP Streamable HTTP endpoint (stateless mode)
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
import { getAllHeadlessStates, loadHeadlessState } from './headless-state.js';
import { registerTools } from './tools/index.js';
import { getClient as getConnectedClient, getConnectionState } from './connection-manager.js';

// 固定端口
export const HTTP_PORT = 18963;

// Hook 脚本路径
export const HOOK_SCRIPT_PATH = path.join(os.homedir(), '.wecom-aibot-mcp', 'permission-hook.sh');

let httpServer: http.Server | null = null;
let startTime: number = 0;

// 审批请求接口
export interface ApprovalRequest {
  tool_name: string;
  tool_input: Record<string, unknown>;
  projectDir?: string;
}

// 审批状态条目
interface ApprovalEntry {
  taskId: string;
  status: 'pending' | 'allow-once' | 'deny';
  timestamp: number;
  tool_name: string;
  tool_input: Record<string, unknown>;
  projectDir?: string;
  description: string;
  timer?: NodeJS.Timeout;
}

// 使用 Map 存储多个待处理审批
const pendingApprovals: Map<string, ApprovalEntry> = new Map();
const APPROVAL_TIMEOUT_MS = parseInt(process.env.APPROVAL_TIMEOUT_MS || '600000', 10);  // 默认 10 分钟，可通过环境变量配置

const VERSION = '1.0.9';

function createMcpServer(): McpServer {
  const server = new McpServer({
    name: 'wecom-aibot-mcp',
    version: VERSION,
  });
  registerTools(server);
  return server;
}

export async function startHttpServer(
  _server: McpServer,
  port: number = HTTP_PORT
): Promise<void> {
  startTime = Date.now();

  return new Promise((resolve, reject) => {
    httpServer = http.createServer(async (req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Mcp-Session-Id');

      if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
      }

      const url = req.url || '/';

      // MCP endpoint
      if (url === '/mcp' || url.startsWith('/mcp?')) {
        let server: McpServer | null = null;
        try {
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
          });
          server = createMcpServer();
          await server.connect(transport);
          await transport.handleRequest(req, res);
        } catch (err) {
          console.error('[http] MCP 请求处理失败:', err);
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: (err as Error).message }));
          }
        } finally {
          if (server) {
            try { await server.close(); } catch {}
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

      if (req.method === 'POST' && url === '/set_auto_approve') {
        await handleSetAutoApprove(req, res);
        return;
      }

      if (req.method === 'POST' && url === '/trigger_keepalive') {
        await handleTriggerKeepalive(req, res);
        return;
      }

      if (req.method === 'POST' && url === '/trigger_auto_approve') {
        await handleTriggerAutoApprove(req, res);
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

    httpServer.listen(port, '127.0.0.1', () => {
      console.log(`[http] MCP Server 已启动: http://127.0.0.1:${port}`);
      console.log(`[http] MCP endpoint: http://127.0.0.1:${port}/mcp (stateless mode)`);
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

    const projectDir = request.projectDir || '';

    // 去重检查：如果该项目已有待处理审批，返回已有的 taskId
    const existingApproval = pendingApprovals.get(projectDir);
    if (existingApproval && existingApproval.status === 'pending') {
      const isSameOperation =
        existingApproval.tool_name === request.tool_name &&
        JSON.stringify(existingApproval.tool_input) === JSON.stringify(request.tool_input);

      if (isSameOperation) {
        console.log(`[http] 审批请求去重: ${existingApproval.taskId}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          taskId: existingApproval.taskId,
          status: 'pending',
          duplicated: true
        }));
        return;
      }
    }

    // 获取 client（根据 projectDir）
    const client = await getConnectedClient(projectDir);
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

    console.log(`[http] 审批请求已发送: ${taskId} (项目: ${projectDir})`);

    // 检查该项目的 autoApprove 设置
    const projectHeadlessState = loadHeadlessState(projectDir);
    if (!projectHeadlessState?.autoApprove) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ taskId, status: 'pending', autoApprove: false }));
      return;
    }

    // autoApprove=true 模式：存储审批并启动超时计时器
    const entry: ApprovalEntry = {
      taskId,
      status: 'pending',
      timestamp: Date.now(),
      tool_name,
      tool_input,
      projectDir,
      description,
    };

    // 启动超时计时器
    entry.timer = setTimeout(() => onApprovalTimeout(projectDir), APPROVAL_TIMEOUT_MS);

    pendingApprovals.set(projectDir, entry);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ taskId, status: 'pending', autoApprove: true }));
  } catch (err) {
    console.error('[http] 审批请求处理失败:', err);
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: (err as Error).message }));
  }
}

async function onApprovalTimeout(projectDir: string): Promise<void> {
  const entry = pendingApprovals.get(projectDir);
  if (!entry || entry.status !== 'pending') return;

  const client = await getConnectedClient(projectDir);
  if (!client) {
    pendingApprovals.delete(projectDir);
    return;
  }

  const result = client.getApprovalResult(entry.taskId);
  if (result === 'pending') {
    const decision = smartAutoApprove(entry.tool_name, entry.tool_input, projectDir);
    entry.status = decision;
    console.log(`[http] 超时智能代批: ${entry.taskId} -> ${decision} (项目: ${projectDir})`);

    const decisionText = decision === 'allow-once' ? '✅ 已自动允许' : '❌ 已自动拒绝';
    await client.sendText(`【自动审批】${decisionText}\n${entry.description}`);
  }

  pendingApprovals.delete(projectDir);
}

function handleApprovalStatus(_req: http.IncomingMessage, res: http.ServerResponse, url: string): void {
  const taskId = url.replace('/approval_status/', '');

  // 遍历所有待处理审批找到匹配的 taskId
  for (const [projectDir, entry] of pendingApprovals) {
    if (entry.taskId === taskId) {
      getConnectedClient(projectDir).then(client => {
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
  }

  // 没找到对应的待处理审批，返回 pending
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'pending', result: 'pending' }));
}

function smartAutoApprove(tool_name: string, tool_input: Record<string, unknown>, projectDir?: string): 'allow-once' | 'deny' {
  if (tool_name === 'Bash') {
    const cmd = (tool_input?.command as string) || '';
    if (/\brm\s/.test(cmd) || /\brmdir\s/.test(cmd)) return 'deny';
    if (/^(npm|npx|git|node)\s/.test(cmd)) return 'allow-once';
    return 'deny';
  }
  if (tool_name === 'Write' || tool_name === 'Edit') {
    if (tool_input?.mode === 'delete') return 'deny';
    return 'allow-once';
  }
  return 'deny';
}

function handleHealthCheck(_req: http.IncomingMessage, res: http.ServerResponse): void {
  const state = getConnectionState();
  const headlessState = loadHeadlessState();

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    status: 'ok',
    uptime: Math.floor((Date.now() - startTime) / 1000),
    websocket: { connected: state.connected, robotName: state.robotName },
    headless: headlessState ? { mode: 'HEADLESS', agentName: headlessState.agentName } : { mode: 'NORMAL' },
  }, null, 2));
}

function handleStateQuery(_req: http.IncomingMessage, res: http.ServerResponse): void {
  const state = getConnectionState();
  const headlessStates = getAllHeadlessStates();

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    connection: state,
    headless: headlessStates.map(s => ({
      projectDir: s.projectDir,
      agentName: s.state.agentName,
      robotName: s.state.robotName,
    })),
  }, null, 2));
}

async function handleNotify(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  try {
    const body = await readRequestBody(req);
    const { title, message, projectDir } = JSON.parse(body);

    // 使用请求中的 projectDir，或回退到当前目录
    const dir = projectDir || process.cwd();
    const client = await getConnectedClient(dir);
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

async function handleSetAutoApprove(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
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
    res.end(JSON.stringify({ success: true, autoApprove: state.autoApprove }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: (err as Error).message }));
  }
}

async function handleTriggerKeepalive(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  try {
    const body = await readRequestBody(req);
    const { projectDir } = JSON.parse(body);

    const dir = projectDir || process.cwd();
    const state = loadHeadlessState(dir);
    if (!state) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '未在 headless 模式' }));
      return;
    }

    const client = await getConnectedClient(dir);
    if (!client) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '未连接机器人' }));
      return;
    }

    // 获取待处理审批
    const pendingApprovals = client.getPendingApprovalsRecords();

    if (pendingApprovals.length === 0) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, message: '无待处理审批' }));
      return;
    }

    // 发送保活消息
    const now = Date.now();
    let sent = 0;
    for (const approval of pendingApprovals) {
      const waitTime = now - approval.timestamp;
      const minutes = Math.floor(waitTime / 60000);

      const message = `【审批提醒】您有 ${minutes} 分钟前的审批请求待处理（${approval.toolName || '未知操作'}），请尽快在企业微信中审批。`;
      const result = await client.sendText(message);
      if (result) sent++;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, sent, total: pendingApprovals.length }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: (err as Error).message }));
  }
}

async function handleTriggerAutoApprove(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  try {
    const body = await readRequestBody(req);
    const { projectDir } = JSON.parse(body);

    const dir = projectDir || process.cwd();
    const state = loadHeadlessState(dir);
    if (!state) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '未在 headless 模式' }));
      return;
    }

    // 获取该项目的待处理审批
    const entry = pendingApprovals.get(dir);
    if (entry && entry.status === 'pending') {
      const client = await getConnectedClient(dir);
      if (client) {
        const result = client.getApprovalResult(entry.taskId);
        if (result === 'pending') {
          const decision = smartAutoApprove(entry.tool_name, entry.tool_input, dir);
          entry.status = decision;

          // 清除计时器
          if (entry.timer) {
            clearTimeout(entry.timer);
          }

          console.log(`[http] 手动触发智能代批: ${entry.taskId} -> ${decision} (项目: ${dir})`);

          const decisionText = decision === 'allow-once' ? '✅ 已自动允许' : '❌ 已自动拒绝';
          await client.sendText(`【自动审批】${decisionText}\n${entry.description}`);

          pendingApprovals.delete(dir);

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, taskId: entry.taskId, decision }));
          return;
        }
      }
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, message: '无待处理审批' }));
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