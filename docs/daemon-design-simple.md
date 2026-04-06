# 连接守护设计 (简化版)

## 核心理念

**守护的是通道，不是消息队列**

- 微信 API 自带消息缓存
- 只要 WebSocket 连接在，消息就能正常收发
- 守护进程职责：**维持连接、自动重连**

---

## 一、架构

```
┌─────────────────────────────────────────────────────────┐
│                   MCP Server (HTTP)                      │
│  - 处理 MCP 请求                                         │
│  - 调用守护进程 API                                       │
└─────────────────────────┬───────────────────────────────┘
                          │ HTTP (本地)
                          ▼
┌─────────────────────────────────────────────────────────┐
│              Connection Daemon (守护进程)                 │
│                                                         │
│  ┌─────────────────────────────────────────────────┐   │
│  │  WebSocket 连接池                                │   │
│  │  - robot-1 ──► 企业微信 API                      │   │
│  │  - robot-2 ──► 企业微信 API                      │   │
│  └─────────────────────────────────────────────────┘   │
│                                                         │
│  ┌─────────────────────────────────────────────────┐   │
│  │  自动重连机制                                     │   │
│  │  - 心跳检测                                       │   │
│  │  - 断线重连 (指数退避)                            │   │
│  │  - 重连通知                                       │   │
│  └─────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

---

## 二、守护进程职责

| 职责 | 说明 |
|------|------|
| **连接管理** | 建立/断开 WebSocket 连接 |
| **心跳保活** | 定期发送心跳，检测连接状态 |
| **自动重连** | 断线后自动重连 (指数退避) |
| **状态暴露** | 提供 HTTP API 查询连接状态 |
| **事件通知** | 连接状态变化时通知 MCP Server |

---

## 三、实现

### 3.1 守护进程入口

```typescript
// src/daemon/index.ts

import { WecomClient } from '../client.js';
import http from 'http';

const DAEMON_PORT = 18964; // 守护进程 HTTP 端口

class ConnectionDaemon {
  private connections: Map<string, WecomClient> = new Map();
  private server: http.Server;

  // 启动守护进程
  async start(): Promise<void> {
    // 1. 加载所有机器人配置
    const robots = await loadAllRobots();

    // 2. 建立所有 WebSocket 连接
    for (const robot of robots) {
      await this.connectRobot(robot);
    }

    // 3. 启动 HTTP API
    this.startHttpServer();

    console.log(`[daemon] 守护进程已启动，端口: ${DAEMON_PORT}`);
  }

  // 连接机器人
  async connectRobot(config: RobotConfig): Promise<void> {
    const client = new WecomClient(
      config.botId,
      config.secret,
      config.targetUserId,
      config.name
    );

    // 监听连接事件
    client.on('connected', () => {
      console.log(`[daemon] ${config.name} 已连接`);
    });

    client.on('disconnected', (reason) => {
      console.log(`[daemon] ${config.name} 断开: ${reason}`);
      // 自动重连由 WecomClient 内部处理
    });

    client.connect();
    this.connections.set(config.name, client);
  }

  // HTTP API
  startHttpServer(): void {
    this.server = http.createServer(async (req, res) => {
      const url = req.url || '/';

      // 获取连接状态
      if (url === '/status') {
        const status = this.getStatus();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(status));
        return;
      }

      // 发送消息
      if (url === '/send' && req.method === 'POST') {
        const body = await readBody(req);
        const { robotName, message } = JSON.parse(body);
        const client = this.connections.get(robotName);
        if (client) {
          const result = await client.sendText(message);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: result }));
        } else {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '机器人未连接' }));
        }
        return;
      }

      // 获取客户端 (供 MCP Server 使用)
      if (url.startsWith('/client/')) {
        const robotName = url.replace('/client/', '');
        const client = this.connections.get(robotName);
        if (client) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ connected: client.isConnected() }));
        } else {
          res.writeHead(404);
          res.end();
        }
        return;
      }

      res.writeHead(404);
      res.end();
    });

    this.server.listen(DAEMON_PORT, '127.0.0.1');
  }

  // 获取状态
  getStatus(): any {
    const status: any = {};
    for (const [name, client] of this.connections) {
      status[name] = {
        connected: client.isConnected(),
      };
    }
    return status;
  }
}

// 启动
const daemon = new ConnectionDaemon();
daemon.start();
```

### 3.2 MCP Server 调用守护进程

```typescript
// src/connection-manager.ts

const DAEMON_URL = 'http://127.0.0.1:18964';

export async function getClient(robotName: string): Promise<WecomClient | null> {
  // 检查守护进程是否运行
  const status = await fetch(`${DAEMON_URL}/client/${robotName}`);
  if (!status.ok) {
    console.log('[connection] 守护进程未运行');
    return null;
  }

  // 通过代理调用
  return new DaemonClientProxy(robotName);
}

class DaemonClientProxy {
  constructor(private robotName: string) {}

  async sendText(content: string): Promise<boolean> {
    const res = await fetch(`${DAEMON_URL}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        robotName: this.robotName,
        message: content
      })
    });
    const data = await res.json();
    return data.success;
  }
}
```

---

## 四、进程管理

### 4.1 CLI 命令

```bash
# 启动守护进程
node dist/daemon.js --start

# 停止守护进程
node dist/daemon.js --stop

# 查看状态
node dist/daemon.js --status

# 重启守护进程
node dist/daemon.js --restart
```

### 4.2 自启动

**macOS (launchd)**:
```xml
<!-- ~/Library/LaunchAgents/com.wecom.daemon.plist -->
<key>ProgramArguments</key>
<array>
  <string>node</string>
  <string>/path/to/dist/daemon.js</string>
  <string>--start</string>
</array>
<key>RunAtLoad</key>
<true/>
<key>KeepAlive</key>
<true/>
```

**Linux (systemd)**:
```ini
# /etc/systemd/system/wecom-daemon.service
[Unit]
Description=WeChat Bot Connection Daemon

[Service]
Type=simple
ExecStart=/usr/bin/node /path/to/dist/daemon.js --start
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

---

## 五、关键特性

### 5.1 自动重连 (在 WecomClient 中实现)

```typescript
// src/client.ts

private setupAutoReconnect(): void {
  this.wsClient.on('disconnected', (reason) => {
    console.log(`[wecom] 断开: ${reason}`);
    this.scheduleReconnect();
  });
}

private scheduleReconnect(): void {
  const delay = Math.min(
    1000 * Math.pow(2, this.reconnectAttempts),
    60000 // 最大 60 秒
  );

  console.log(`[wecom] ${delay/1000}秒后重连...`);

  setTimeout(() => {
    this.reconnectAttempts++;
    this.connect();
  }, delay);
}
```

### 5.2 心跳检测

```typescript
// 微信 SDK 自带心跳 (15秒)
// 额外添加应用层心跳检测

private startHeartbeatMonitor(): void {
  setInterval(() => {
    if (!this.isConnected()) {
      console.log('[wecom] 心跳检测: 连接已断开');
      this.scheduleReconnect();
    }
  }, 30000); // 每 30 秒检测一次
}
```

---

## 六、文件结构

```
src/
├── daemon/
│   └── index.ts        # 守护进程入口
├── client.ts           # WebSocket 客户端 (已有)
├── connection-manager.ts  # 连接管理 (修改)
└── bin.ts              # CLI 入口 (修改)
```

---

## 七、实施步骤

| 步骤 | 内容 |
|------|------|
| 1 | 创建 daemon/index.ts |
| 2 | 添加守护进程启动/停止逻辑 |
| 3 | 修改 connection-manager 调用守护进程 |
| 4 | 添加 launchd/systemd 配置 |
| 5 | 测试断线重连 |

---

*设计版本: 2.0 (简化版)*  
*核心: 守护通道，不守护消息*