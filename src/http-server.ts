/**
 * 本地 HTTP 服务模块
 *
 * 为 PreToolUse hooks 提供审批接口（备用）
 * 与 MCP Server 共享同一个 WecomClient 实例
 */
import * as http from 'http';
import type { WecomClient } from './client.js';

let httpServer: http.Server | null = null;
let sharedClient: WecomClient | null = null;
export const HOOK_PORT = 18963; // 固定端口，hook 脚本硬编码此值

export interface ApprovalRequest {
  tool_name: string;
  tool_input: Record<string, unknown>;
  session_id?: string;
}

export interface ApprovalResponse {
  decision: 'allow' | 'deny' | 'ask';
  reason?: string;
}

/**
 * 启动本地 HTTP 服务
 */
export function startHttpServer(client: WecomClient, port: number = HOOK_PORT): Promise<void> {
  return new Promise((resolve, reject) => {
    sharedClient = client;

    httpServer = http.createServer(async (req, res) => {
      // CORS headers
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

      if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
      }

      // 审批接口（非阻塞，发送卡片后立即返回）
      if (req.method === 'POST' && req.url === '/approve') {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', async () => {
          try {
            const request: ApprovalRequest = JSON.parse(body);
            const result = await handleApprovalRequest(request);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
          } catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: (err as Error).message }));
          }
        });
        return;
      }

      // 审批状态查询接口（非阻塞）
      if (req.method === 'GET' && req.url?.startsWith('/approval_status/')) {
        const taskId = req.url.replace('/approval_status/', '');
        const result = getApprovalStatus(taskId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
        return;
      }

      // 健康检查
      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', connected: client.isConnected() }));
        return;
      }

      // 404
      res.writeHead(404);
      res.end('Not Found');
    });

    httpServer.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`[http] 端口 ${port} 已被占用，hook 无法工作。请确保没有其他 wecom-aibot-mcp 实例在运行。`);
      }
      reject(err);
    });

    httpServer.listen(port, '127.0.0.1', () => {
      console.log(`[http] 审批服务已启动: http://127.0.0.1:${port}/approve`);
      resolve();
    });
  });
}

/**
 * 停止 HTTP 服务
 */
export function stopHttpServer() {
  if (httpServer) {
    httpServer.close();
    httpServer = null;
  }
}

/**
 * 处理审批请求（非阻塞）
 *
 * 流程：
 * 1. 发送审批卡片到微信
 * 2. 立即返回 taskId，状态为 pending
 * 3. Hook 脚本负责轮询 /approval_status/{taskId} 获取结果
 */
async function handleApprovalRequest(request: ApprovalRequest): Promise<{ taskId: string; status: string }> {
  if (!sharedClient) {
    throw new Error('WecomClient 未初始化');
  }

  if (!sharedClient.isConnected()) {
    throw new Error('WebSocket 未连接');
  }

  // 构建审批描述
  const { tool_name, tool_input } = request;
  let description = '';

  if (tool_name === 'Bash') {
    description = `执行命令: ${tool_input.command || '(unknown)'}`;
  } else if (tool_name === 'Write' || tool_name === 'Edit') {
    description = `操作文件: ${tool_input.file_path || '(unknown)'}`;
  } else {
    description = `工具: ${tool_name}`;
  }

  const title = `【待审批】${tool_name}`;
  const requestId = `hook_${Date.now()}`;

  // 发送审批请求（非阻塞）
  const taskId = await sharedClient.sendApprovalRequest(
    title,
    description,
    requestId
  );

  console.log(`[http] 审批请求已发送: ${taskId}`);

  // 立即返回，不等待结果
  return { taskId, status: 'pending' };
}

/**
 * 查询审批状态（非阻塞）
 */
function getApprovalStatus(taskId: string): { status: string; result?: string } {
  if (!sharedClient) {
    return { status: 'error', result: 'WecomClient 未初始化' };
  }

  const result = sharedClient.getApprovalResult(taskId);
  return { status: result, result: result === 'pending' ? undefined : result };
}