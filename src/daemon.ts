#!/usr/bin/env node
/**
 * 连接守护进程
 *
 * 职责：维持所有机器人的 WebSocket 连接
 * - 自动重连
 * - 心跳检测
 * - 状态暴露
 */

import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { WecomClient } from './client.js';
import { logger } from './logger.js';

const CONFIG_DIR = path.join(os.homedir(), '.wecom-aibot-mcp');
const DAEMON_PORT = 18964;
const PID_FILE = path.join(CONFIG_DIR, 'daemon.pid');
const LOG_FILE = path.join(CONFIG_DIR, 'daemon.log');

interface RobotConfig {
  name: string;
  botId: string;
  secret: string;
  targetUserId: string;
}

class ConnectionDaemon {
  private connections: Map<string, WecomClient> = new Map();
  private server: http.Server | null = null;
  private startTime: number = 0;

  async start(): Promise<void> {
    this.startTime = Date.now();

    // 确保目录存在
    if (!fs.existsSync(CONFIG_DIR)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
    }

    // 写入 PID
    fs.writeFileSync(PID_FILE, process.pid.toString());

    this.log('守护进程启动中...');

    // 加载所有机器人配置
    const robots = this.loadAllRobots();
    this.log(`发现 ${robots.length} 个机器人配置`);

    // 建立所有 WebSocket 连接
    for (const robot of robots) {
      await this.connectRobot(robot);
    }

    // 启动 HTTP API
    this.startHttpServer();

    this.log(`守护进程已启动，端口: ${DAEMON_PORT}`);
    this.log(`PID: ${process.pid}`);

    // 处理退出信号
    process.on('SIGINT', () => this.shutdown());
    process.on('SIGTERM', () => this.shutdown());
  }

  loadAllRobots(): RobotConfig[] {
    const robots: RobotConfig[] = [];

    // 主配置文件
    const mainConfigPath = path.join(CONFIG_DIR, 'config.json');
    if (fs.existsSync(mainConfigPath)) {
      try {
        const config = JSON.parse(fs.readFileSync(mainConfigPath, 'utf-8'));
        robots.push({
          name: config.nameTag || 'default',
          botId: config.botId,
          secret: config.secret,
          targetUserId: config.targetUserId,
        });
      } catch (err) {
        this.log(`加载主配置失败: ${err}`);
      }
    }

    // 机器人配置文件 (robot-*.json)
    const files = fs.readdirSync(CONFIG_DIR).filter(f => f.startsWith('robot-') && f.endsWith('.json'));
    for (const file of files) {
      try {
        const config = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, file), 'utf-8'));
        robots.push({
          name: config.nameTag || file.replace('robot-', '').replace('.json', ''),
          botId: config.botId,
          secret: config.secret,
          targetUserId: config.targetUserId,
        });
      } catch (err) {
        this.log(`加载 ${file} 失败: ${err}`);
      }
    }

    return robots;
  }

  async connectRobot(config: RobotConfig): Promise<void> {
    this.log(`连接机器人: ${config.name}...`);

    const client = new WecomClient(
      config.botId,
      config.secret,
      config.targetUserId,
      config.name
    );

    // 连接
    client.connect();

    // 等待连接建立
    const connected = await this.waitForConnection(client, 10000);

    if (connected) {
      this.connections.set(config.name, client);
      this.log(`✅ ${config.name} 已连接`);
    } else {
      this.log(`❌ ${config.name} 连接失败，将在后台重试`);
      // 仍然保存 client，SDK 会自动重连
      this.connections.set(config.name, client);
    }
  }

  async waitForConnection(client: WecomClient, timeout: number): Promise<boolean> {
    return new Promise((resolve) => {
      const startTime = Date.now();
      const check = () => {
        if (client.isConnected()) {
          resolve(true);
        } else if (Date.now() - startTime > timeout) {
          resolve(false);
        } else {
          setTimeout(check, 500);
        }
      };
      check();
    });
  }

  startHttpServer(): void {
    this.server = http.createServer(async (req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      res.setHeader('Content-Type', 'application/json');

      const url = req.url || '/';

      if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
      }

      // 健康检查
      if (url === '/health') {
        res.writeHead(200);
        res.end(JSON.stringify({
          status: 'ok',
          uptime: Math.floor((Date.now() - this.startTime) / 1000),
          pid: process.pid,
        }));
        return;
      }

      // 所有连接状态
      if (url === '/status') {
        const status = this.getStatus();
        res.writeHead(200);
        res.end(JSON.stringify(status, null, 2));
        return;
      }

      // 单个机器人状态
      if (url.startsWith('/status/')) {
        const name = decodeURIComponent(url.replace('/status/', ''));
        const client = this.connections.get(name);
        if (client) {
          res.writeHead(200);
          res.end(JSON.stringify({
            name,
            connected: client.isConnected(),
          }));
        } else {
          res.writeHead(404);
          res.end(JSON.stringify({ error: '机器人未找到' }));
        }
        return;
      }

      // 发送消息
      if (url === '/send' && req.method === 'POST') {
        const body = await this.readBody(req);
        try {
          const { robotName, message } = JSON.parse(body);
          const client = this.connections.get(robotName);
          if (client) {
            const result = await client.sendText(message);
            res.writeHead(200);
            res.end(JSON.stringify({ success: result }));
          } else {
            res.writeHead(404);
            res.end(JSON.stringify({ error: '机器人未连接' }));
          }
        } catch (err: any) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: err.message }));
        }
        return;
      }

      // 发送审批
      if (url === '/approve' && req.method === 'POST') {
        const body = await this.readBody(req);
        try {
          const { robotName, title, description, requestId } = JSON.parse(body);
          const client = this.connections.get(robotName);
          if (client) {
            const taskId = await client.sendApprovalRequest(title, description, requestId);
            res.writeHead(200);
            res.end(JSON.stringify({ taskId }));
          } else {
            res.writeHead(404);
            res.end(JSON.stringify({ error: '机器人未连接' }));
          }
        } catch (err: any) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: err.message }));
        }
        return;
      }

      // 获取审批结果
      if (url.startsWith('/approval/')) {
        const parts = url.split('/');
        const robotName = decodeURIComponent(parts[2]);
        const taskId = parts[3];
        const client = this.connections.get(robotName);
        if (client) {
          const result = client.getApprovalResult(taskId);
          res.writeHead(200);
          res.end(JSON.stringify({ result }));
        } else {
          res.writeHead(404);
          res.end(JSON.stringify({ error: '机器人未连接' }));
        }
        return;
      }

      // 模拟断线 (测试用)
      if (url.startsWith('/disconnect/') && req.method === 'POST') {
        const name = decodeURIComponent(url.replace('/disconnect/', ''));
        const client = this.connections.get(name);
        if (client) {
          this.log(`[测试] 模拟断开: ${name}`);
          client.disconnect();
          res.writeHead(200);
          res.end(JSON.stringify({ success: true, message: `已断开 ${name}` }));
        } else {
          res.writeHead(404);
          res.end(JSON.stringify({ error: '机器人未找到' }));
        }
        return;
      }

      // 模拟重连 (测试用)
      if (url.startsWith('/reconnect/') && req.method === 'POST') {
        const name = decodeURIComponent(url.replace('/reconnect/', ''));
        const client = this.connections.get(name);
        if (client) {
          this.log(`[测试] 模拟重连: ${name}`);
          client.connect();
          res.writeHead(200);
          res.end(JSON.stringify({ success: true, message: `正在重连 ${name}` }));
        } else {
          res.writeHead(404);
          res.end(JSON.stringify({ error: '机器人未找到' }));
        }
        return;
      }

      // 重载机器人配置
      if (url === '/reload' && req.method === 'POST') {
        await this.reloadRobots();
        res.writeHead(200);
        res.end(JSON.stringify({ success: true }));
        return;
      }

      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Not Found' }));
    });

    this.server.listen(DAEMON_PORT, '127.0.0.1');
  }

  getStatus(): any {
    const connections: any = {};
    for (const name of Array.from(this.connections.keys())) {
      const client = this.connections.get(name)!;
      connections[name] = {
        connected: client.isConnected(),
      };
    }
    return {
      daemon: {
        uptime: Math.floor((Date.now() - this.startTime) / 1000),
        pid: process.pid,
        port: DAEMON_PORT,
      },
      connections,
    };
  }

  async reloadRobots(): Promise<void> {
    this.log('重载机器人配置...');
    const robots = this.loadAllRobots();

    // 断开不再存在的机器人
    for (const name of Array.from(this.connections.keys())) {
      if (!robots.find(r => r.name === name)) {
        this.log(`断开机器人: ${name}`);
        const client = this.connections.get(name);
        client?.disconnect();
        this.connections.delete(name);
      }
    }

    // 连接新机器人或重连
    for (const robot of robots) {
      if (!this.connections.has(robot.name)) {
        await this.connectRobot(robot);
      }
    }
  }

  readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => resolve(body));
      req.on('error', reject);
    });
  }

  log(message: string): void {
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] ${message}`;
    logger.log(line);
    fs.appendFileSync(LOG_FILE, line + '\n');
  }

  async shutdown(): Promise<void> {
    this.log('守护进程关闭中...');

    // 断开所有连接
    for (const name of Array.from(this.connections.keys())) {
      const client = this.connections.get(name)!;
      client.disconnect();
      this.log(`已断开: ${name}`);
    }

    // 关闭 HTTP 服务器
    if (this.server) {
      this.server.close();
    }

    // 删除 PID 文件
    fs.unlinkSync(PID_FILE);

    this.log('守护进程已关闭');
    process.exit(0);
  }
}

// CLI
const args = process.argv.slice(2);
const command = args[0];

if (command === '--stop') {
  // 停止守护进程
  if (fs.existsSync(PID_FILE)) {
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf-8'));
    try {
      process.kill(pid, 'SIGTERM');
      logger.log(`守护进程已停止 (PID: ${pid})`);
    } catch {
      logger.log('守护进程未运行');
    }
    fs.unlinkSync(PID_FILE);
  } else {
    logger.log('守护进程未运行');
  }
} else if (command === '--status') {
  // 查看状态
  http.get(`http://127.0.0.1:${DAEMON_PORT}/status`, (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
      logger.log(JSON.stringify(JSON.parse(data), null, 2));
    });
  }).on('error', () => {
    logger.log('守护进程未运行');
  });
} else {
  // 启动守护进程
  const daemon = new ConnectionDaemon();
  daemon.start();
}