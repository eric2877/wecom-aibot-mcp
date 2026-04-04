/**
 * 本地 HTTP 服务模块
 *
 * 为 PreToolUse hooks 提供审批接口（备用）
 * 与 MCP Server 共享同一个 WecomClient 实例
 */
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import type { WecomClient } from './client.js';

let httpServer: http.Server | null = null;
let sharedClient: WecomClient | null = null;
let currentPort: number = 0;
export const HOOK_PORT_DEFAULT = 18963; // 默认端口

const CONFIG_DIR = path.join(process.env.HOME || '/tmp', '.wecom-aibot-mcp');

// 获取端口文件路径（按 PID）
function getPortFilePath(): string {
  return path.join(CONFIG_DIR, `port-${process.pid}`);
}

// 获取 headless 状态文件路径（按 PID）
export function getHeadlessFilePath(): string {
  return path.join(CONFIG_DIR, `headless-${process.pid}`);
}

// 写入端口文件
function writePortFile(port: number): void {
  try {
    if (!fs.existsSync(CONFIG_DIR)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
    }
    fs.writeFileSync(getPortFilePath(), String(port));
    console.log(`[http] 端口文件已写入: ${getPortFilePath()} -> ${port}`);
  } catch (err) {
    console.error(`[http] 写入端口文件失败: ${err}`);
  }
}

// 清理端口文件
export function cleanupPortFile(): void {
  try {
    const portFile = getPortFilePath();
    if (fs.existsSync(portFile)) {
      fs.unlinkSync(portFile);
      console.log(`[http] 端口文件已清理: ${portFile}`);
    }
  } catch (err) {
    console.error(`[http] 清理端口文件失败: ${err}`);
  }
}

// 清理 headless 状态文件
export function cleanupHeadlessFile(): void {
  try {
    const headlessFile = getHeadlessFilePath();
    if (fs.existsSync(headlessFile)) {
      fs.unlinkSync(headlessFile);
      console.log(`[http] headless 文件已清理: ${headlessFile}`);
    }
  } catch (err) {
    console.error(`[http] 清理 headless 文件失败: ${err}`);
  }
}

// 清理孤儿端口文件（进程已不存在）
function cleanupOrphanFiles(): void {
  try {
    if (!fs.existsSync(CONFIG_DIR)) {
      return;
    }

    const files = fs.readdirSync(CONFIG_DIR);
    const portFiles = files.filter(f => f.startsWith('port-'));
    const headlessFiles = files.filter(f => f.startsWith('headless-'));

    for (const portFile of portFiles) {
      const pid = parseInt(portFile.replace('port-', ''), 10);
      // 检查进程是否存在
      try {
        process.kill(pid, 0); // 如果进程存在，这不会抛错
        // 进程存在，不清理
      } catch {
        // 进程不存在，清理文件
        fs.unlinkSync(path.join(CONFIG_DIR, portFile));
        console.log(`[http] 清理孤儿端口文件: ${portFile} (PID ${pid} 已不存在)`);
        // 同时清理对应的 headless 文件
        const headlessFile = `headless-${pid}`;
        const headlessPath = path.join(CONFIG_DIR, headlessFile);
        if (fs.existsSync(headlessPath)) {
          fs.unlinkSync(headlessPath);
          console.log(`[http] 清理孤儿 headless 文件: ${headlessFile}`);
        }
      }
    }
  } catch (err) {
    console.error(`[http] 清理孤儿文件失败: ${err}`);
  }
}

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
 * 启动本地 HTTP 服务（端口自动递增）
 */
export function startHttpServer(client: WecomClient, port: number = HOOK_PORT_DEFAULT): Promise<void> {
  return new Promise((resolve, reject) => {
    sharedClient = client;

    // 启动前清理孤儿文件
    cleanupOrphanFiles();

    // 尝试启动，端口被占用时递增
    const tryStart = (attemptPort: number): void => {
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
        // 端口被占用，尝试下一个端口
        const nextPort = attemptPort + 1;
        if (nextPort > HOOK_PORT_DEFAULT + 100) {
          // 最多尝试 100 个端口
          reject(new Error(`无法找到可用端口 (${HOOK_PORT_DEFAULT}-${HOOK_PORT_DEFAULT + 100})`));
          return;
        }
        console.log(`[http] 端口 ${attemptPort} 已被占用，尝试 ${nextPort}...`);
        tryStart(nextPort);
        return;
      }
      reject(err);
    });

    httpServer.listen(attemptPort, '127.0.0.1', () => {
      currentPort = attemptPort;
      writePortFile(attemptPort);
      console.log(`[http] 审批服务已启动: http://127.0.0.1:${attemptPort}/approve`);
      resolve();
    });
    };

    // 注册退出时清理
    process.on('exit', () => {
      cleanupPortFile();
      cleanupHeadlessFile();
    });

    // 开始尝试启动
    tryStart(port);
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