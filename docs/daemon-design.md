# 连接守护架构设计

## 一、设计目标

| 目标 | 说明 |
|------|------|
| 连接持久化 | MCP Server 重启不影响 WebSocket 连接 |
| 消息持久化 | 断线期间消息不丢失，重连后自动发送 |
| 自动恢复 | 守护进程异常退出后自动重启 |
| 状态共享 | 多进程可访问连接状态 |

---

## 二、架构设计

### 2.1 整体架构

```
┌─────────────────────────────────────────────────────────┐
│                    Claude Code (CC)                      │
└─────────────────────────┬───────────────────────────────┘
                          │ HTTP/MCP
                          ▼
┌─────────────────────────────────────────────────────────┐
│                   MCP Server (HTTP)                      │
│  - 处理 MCP 请求                                         │
│  - 管理 Session                                          │
│  - 通过 Unix Socket 与守护进程通信                        │
└─────────────────────────┬───────────────────────────────┘
                          │ Unix Socket / Redis
                          ▼
┌─────────────────────────────────────────────────────────┐
│              Connection Daemon (守护进程)                 │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐      │
│  │ WebSocket 1 │  │ WebSocket 2 │  │ WebSocket N │      │
│  │ (robot-1)   │  │ (robot-2)   │  │ (robot-N)   │      │
│  └─────────────┘  └─────────────┘  └─────────────┘      │
│                                                         │
│  ┌─────────────────────────────────────────────────┐   │
│  │           消息队列 (持久化存储)                    │   │
│  │  - 待发送消息                                     │   │
│  │  - 待处理审批                                     │   │
│  │  - 审批结果                                       │   │
│  └─────────────────────────────────────────────────┘   │
└─────────────────────────┬───────────────────────────────┘
                          │ WebSocket
                          ▼
┌─────────────────────────────────────────────────────────┐
│                  企业微信 API                            │
└─────────────────────────────────────────────────────────┘
```

### 2.2 进程职责

| 进程 | 职责 | 生命周期 |
|------|------|----------|
| MCP Server | 处理 HTTP 请求、MCP 协议、Session 管理 | 可随时重启 |
| Connection Daemon | WebSocket 连接管理、消息队列、自动重连 | 常驻运行 |
| Supervisor | 监控守护进程，异常退出时重启 | 系统级 |

---

## 三、核心组件设计

### 3.1 Connection Daemon

```typescript
// src/daemon/index.ts

interface DaemonConfig {
  socketPath: string;      // Unix Socket 路径
  dataDir: string;         // 数据目录
  reconnectInterval: number; // 重连间隔
  maxReconnectAttempts: number; // 最大重连次数
}

class ConnectionDaemon {
  private connections: Map<string, RobotConnection>;
  private messageQueue: PersistentQueue;
  private approvalStore: ApprovalStore;
  private ipcServer: IPCServer;

  // 启动守护进程
  async start(): Promise<void>;

  // 停止守护进程（优雅关闭）
  async stop(): Promise<void>;

  // 注册机器人连接
  async registerRobot(config: RobotConfig): Promise<void>;

  // 断开机器人连接
  async unregisterRobot(robotName: string): Promise<void>;

  // 发送消息（断线时加入队列）
  async sendMessage(robotName: string, message: OutgoingMessage): Promise<SendResult>;

  // 发送审批请求
  async sendApproval(robotName: string, approval: ApprovalRequest): Promise<string>;

  // 获取审批结果
  async getApprovalResult(taskId: string): Promise<ApprovalResult | null>;
}
```

### 3.2 消息队列持久化

```typescript
// src/daemon/queue.ts

interface QueuedMessage {
  id: string;
  robotName: string;
  type: 'text' | 'approval' | 'approval_result';
  payload: any;
  timestamp: number;
  retries: number;
  status: 'pending' | 'sent' | 'failed';
}

class PersistentQueue {
  private db: LevelDB; // 或 SQLite

  // 添加消息到队列
  async enqueue(message: QueuedMessage): Promise<void>;

  // 获取待发送消息
  async getPending(robotName: string): Promise<QueuedMessage[]>;

  // 标记消息已发送
  async markSent(messageId: string): Promise<void>;

  // 标记消息发送失败
  async markFailed(messageId: string, error: string): Promise<void>;

  // 清理过期消息
  async cleanup(maxAge: number): Promise<void>;
}
```

### 3.3 IPC 通信

```typescript
// src/daemon/ipc.ts

// Unix Socket 通信协议
interface IPCRequest {
  id: string;
  method: 'sendMessage' | 'sendApproval' | 'getApproval' | 'getStatus' | 'register' | 'unregister';
  params: any;
}

interface IPCResponse {
  id: string;
  success: boolean;
  result?: any;
  error?: string;
}

class IPCServer {
  private server: net.Server;
  private handlers: Map<string, Function>;

  // 处理 MCP Server 请求
  async handleRequest(request: IPCRequest): Promise<IPCResponse>;
}
```

---

## 四、数据存储设计

### 4.1 文件结构

```
~/.wecom-aibot-mcp/
├── daemon.pid           # 守护进程 PID
├── daemon.sock          # Unix Socket
├── config.json          # 机器人配置
├── data/
│   ├── messages.db      # 消息队列 (LevelDB/SQLite)
│   ├── approvals.db     # 审批状态
│   └── stats.json       # 统计信息
└── logs/
    ├── daemon.log       # 守护进程日志
    └── connection.log   # 连接日志
```

### 4.2 消息队列数据结构

```json
{
  "id": "msg_1234567890",
  "robotName": "ClaudeCode",
  "type": "text",
  "payload": {
    "content": "测试消息",
    "targetUser": "LiuYang"
  },
  "timestamp": 1712345678901,
  "retries": 0,
  "status": "pending"
}
```

---

## 五、进程管理

### 5.1 启动顺序

```bash
# 1. 启动守护进程
wecom-daemon --start

# 2. 启动 MCP Server (可与守护进程通信)
wecom-mcp-server --start
```

### 5.2 Supervisor 配置

```ini
# /etc/supervisor.d/wecom-daemon.ini

[program:wecom-daemon]
command=node /path/to/daemon/index.js
autostart=true
autorestart=true
startretries=3
startsecs=5
stopwaitsecs=10
stdout_logfile=/var/log/wecom-daemon.log
stderr_logfile=/var/log/wecom-daemon-error.log
```

### 5.3 launchd (macOS)

```xml
<!-- ~/Library/LaunchAgents/com.wecom.daemon.plist -->
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.wecom.daemon</string>
    <key>ProgramArguments</key>
    <array>
        <string>node</string>
        <string>/path/to/daemon/index.js</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
</dict>
</plist>
```

---

## 六、API 设计

### 6.1 HTTP API (MCP Server 调用守护进程)

```
POST /internal/message
  - 发送消息（断线时加入队列）

POST /internal/approval
  - 发送审批请求

GET /internal/approval/:taskId
  - 获取审批结果

GET /internal/status
  - 获取连接状态

POST /internal/robot/register
  - 注册机器人

POST /internal/robot/unregister
  - 断开机器人
```

### 6.2 CLI 命令

```bash
# 守护进程管理
wecom-daemon --start          # 启动
wecom-daemon --stop           # 停止
wecom-daemon --restart        # 重启
wecom-daemon --status         # 状态
wecom-daemon --logs           # 查看日志

# 队列管理
wecom-daemon --queue list     # 查看队列
wecom-daemon --queue clear    # 清空队列
wecom-daemon --queue retry    # 重试失败消息
```

---

## 七、容错设计

### 7.1 守护进程崩溃

```
守护进程崩溃
    ↓
Supervisor 自动重启
    ↓
从持久化存储恢复连接
    ↓
重连 WebSocket
    ↓
发送队列中的消息
```

### 7.2 MCP Server 重启

```
MCP Server 重启
    ↓
守护进程继续运行
    ↓
MCP Server 重连 Unix Socket
    ↓
正常通信，无需重连 WebSocket
```

### 7.3 网络断开

```
网络断开
    ↓
检测到 WebSocket 断开
    ↓
消息加入持久化队列
    ↓
自动重连 (指数退避)
    ↓
重连成功后发送队列消息
```

---

## 八、实现计划

| Phase | 内容 | 优先级 |
|-------|------|--------|
| P0 | 消息队列持久化 | 高 |
| P0 | 独立守护进程 | 高 |
| P1 | Unix Socket IPC | 中 |
| P1 | Supervisor 集成 | 中 |
| P2 | Web 管理界面 | 低 |

---

## 九、迁移策略

### 9.1 向后兼容

1. 保留现有 MCP Server 接口
2. 内部调用改为守护进程
3. 配置文件格式不变

### 9.2 平滑迁移

```
Phase 1: 添加持久化队列 (不影响现有功能)
Phase 2: 抽取连接管理到独立模块
Phase 3: 实现守护进程模式
Phase 4: 切换默认模式为守护进程
```

---

*设计版本: 1.0*  
*创建日期: 2026-04-06*