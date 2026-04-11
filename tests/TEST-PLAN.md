# 功能测试方案

> 版本：2.0
> 创建日期：2026-04-06
> 更新日期：2026-04-12
> 目标覆盖率：85%

---

## 一、测试模块划分

| 模块 | 文件 | 代码行数 | 优先级 |
|------|------|---------|--------|
| 核心消息处理 | `client.ts` | ~500 | P0 |
| HTTP 服务 | `http-server.ts` | ~600 | P0 |
| 消息总线 | `message-bus.ts` | ~65 | P0 |
| 连接管理 | `connection-manager.ts` | ~200 | P0 |
| MCP 工具 | `tools/index.ts` | ~560 | P0 |
| 配置向导 | `config-wizard.ts` | ~1000 | P1 |
| 保活监控 | `keepalive-monitor.ts` | ~80 | P2 |
| 状态管理 | `headless-state.ts` | ~280 | P1 |
| 连接日志 | `connection-log.ts` | ~220 | P2 |

---

## 二、v2.0 新增测试用例

### 2.0.1 Channel/HTTP 模式测试

| 用例ID | 场景 | 输入 | 预期输出 | 自动化 | 状态 |
|--------|------|------|---------|--------|------|
| MODE-001 | enter_headless_mode (mode=channel) | mode='channel' | message="无需轮询" | ✅ | ✅ 通过 |
| MODE-002 | enter_headless_mode (mode=http) | mode='http' | message="需轮询" | ✅ | ✅ 通过 |
| MODE-003 | enter_headless_mode (默认 mode) | 无 mode 参数 | 默认 http 模式 | ✅ | ✅ 通过 |
| MODE-004 | ccId 注册带 mode | registerCcId(..., 'channel') | entry.mode='channel' | ✅ | ✅ 通过 |
| MODE-005 | heartbeat_check 工具 | 调用 heartbeat_check | 返回提示继续轮询 | ✅ | ✅ 通过 |
| MODE-006 | send_message 返回提示 | 发送消息成功 | 提示等待用户回复 | ✅ | ✅ 通过 |

### 2.0.2 配置需求工具测试

| 用例ID | 场景 | 输入 | 预期输出 | 自动化 | 状态 |
|--------|------|------|---------|--------|------|
| REQ-001 | get_setup_requirements 返回 | 调用工具 | 返回完整配置需求 | ✅ | ✅ 通过 |
| REQ-002 | 权限列表完整 | 检查返回 | 包含所有 mcp__wecom-aibot__* | ✅ | ✅ 通过 |
| REQ-003 | Hook 配置需求 | 检查返回 | 包含 PermissionRequest hook | ✅ | ✅ 通过 |
| REQ-004 | Skill 安装需求 | 检查返回 | 包含 globalDir 和 projectDir | ✅ | ✅ 通过 |
| REQ-005 | 运行模式说明 | 检查返回 | channel/http 两种模式 | ✅ | ✅ 通过 |

### 2.0.3 消息推送模式测试

| 用例ID | 场景 | 输入 | 预期输出 | 自动化 | 状态 |
|--------|------|------|---------|--------|------|
| PUSH-001 | Channel 模式 notification | mode='channel', 微信消息 | SSE notification 推送 | ✅ | 待测试 |
| PUSH-002 | HTTP 模式队列存储 | mode='http', 微信消息 | 存入消息队列等待轮询 | ✅ | 待测试 |
| PUSH-003 | 多 CC 消息路由 | 多 ccId, mode 不同 | 按 ccId + mode 分发 | ✅ | 待测试 |

---

## 三、v2.0 实现总结

### 新增功能

1. **双模式支持**：
   - Channel 模式：SSE 推送，微信消息自动唤醒 Agent
   - HTTP 模式：轮询 + heartbeat_check

2. **配置需求工具**：
   - `get_setup_requirements`：返回完整配置需求
   - 支持远程 MCP 用户通过 skill 自动配置

3. **heartbeat_check 工具**：
   - HTTP 模式保持 Agent 活跃
   - 提示继续轮询

4. **skill 启动检查**：
   - 连接 MCP 后自动检查配置
   - 自动安装权限、Hook、skill

### 删除功能

- 删除 `src/channel.ts`（错误架构）
- 删除 `--channel` 命令

---

## 二、测试场景设计

### 2.1 消息总线测试 (message-bus.ts)

**目标覆盖率：95%**

| 用例ID | 场景 | 输入 | 预期输出 | 自动化 |
|--------|------|------|---------|--------|
| MB-001 | 发布消息 | `publishWecomMessage(msg)` | 订阅者收到消息 | ✅ |
| MB-002 | 订阅所有消息 | `subscribeWecomMessage(cb)` | 收到所有消息 | ✅ |
| MB-003 | 按机器人过滤 | `subscribeWecomMessageByRobot('robot1', cb)` | 只收到 robot1 的消息 | ✅ |
| MB-004 | 多订阅者 | 3 个订阅者 | 都收到消息 | ✅ |
| MB-005 | 取消订阅 | `subscription.unsubscribe()` | 不再收到消息 | ✅ |

### 2.2 WecomClient 测试 (client.ts)

**目标覆盖率：90%**

| 用例ID | 场景 | 输入 | 预期输出 | 自动化 |
|--------|------|------|---------|--------|
| WC-001 | 构造函数 | botId, secret, targetUserId, robotName | 实例创建成功 | ✅ |
| WC-002 | 连接建立 | `connect()` | 触发 connected/authenticated 事件 | ✅ |
| WC-003 | 发送文本消息 | `sendText('hello')` | 返回 true | ✅ |
| WC-004 | 断线时发送 | 未连接时 sendText | 消息加入队列，返回 false | ✅ |
| WC-005 | 发送审批请求 | `sendApprovalRequest()` | 返回 taskId | ✅ |
| WC-006 | 获取审批结果-待处理 | taskId | 返回 'pending' | ✅ |
| WC-007 | 获取审批结果-已批准 | taskId (已批准) | 返回 'allow-once' | ✅ |
| WC-008 | 处理用户消息 | 模拟 WS 消息帧 | 消息发布到总线 | ✅ |
| WC-009 | 处理引用消息 | 消息包含 quote 字段 | quoteContent 正确提取 | ✅ |
| WC-010 | 处理审批响应 | template_card_event | 更新审批状态 | ✅ |
| WC-011 | 重连恢复 | 断线后重连 | pendingMessages 刷新 | ✅ |
| WC-012 | 消息清理 | 超过 5 分钟的消息 | 自动清理 | ✅ |

### 2.3 HTTP Server 测试 (http-server.ts)

**目标覆盖率：85%**

| 用例ID | 场景 | 输入 | 预期输出 | 自动化 |
|--------|------|------|---------|--------|
| HS-001 | 健康检查 | GET /health | 200, status: ok | ✅ |
| HS-002 | 状态查询 | GET /state | 200, 连接状态 | ✅ |
| HS-003 | MCP 初始化 | POST /mcp (initialize) | 200, Session ID | ✅ |
| HS-004 | 工具调用-无 Session | POST /mcp (tools/call) | 400, 需要 Session ID | ✅ |
| HS-005 | 工具调用-有 Session | POST /mcp + Session ID | 200, 工具结果 | ✅ |
| HS-006 | 审批请求 | POST /approve | taskId, status: pending | ✅ |
| HS-007 | 审批状态查询 | GET /approval_status/:taskId | 状态 | ✅ |
| HS-008 | 审批超时 | 等待 10 分钟 | 自动拒绝 | ✅ |
| HS-009 | 消息推送 | WecomMessage | SSE 推送 | ✅ |
| HS-010 | ccId 生成 | enter_headless_mode | 返回 cc-1, cc-2... | ✅ |
| HS-011 | 引用路由 | quoteContent 包含 ccId | 推送给对应 Session | ✅ |
| HS-012 | 单 CC 直接推送 | 只有 1 个 Session | 无需引用，直接推送 | ✅ |
| HS-013 | 多 CC 无引用提示 | 多个 Session，无引用 | 机器人回复提示 | ✅ |
| HS-014 | 404 处理 | GET /unknown | 404 | ✅ |

### 2.4 连接管理测试 (connection-manager.ts)

**目标覆盖率：85%**

| 用例ID | 场景 | 输入 | 预期输出 | 自动化 |
|--------|------|------|---------|--------|
| CM-001 | 连接机器人 | `connectRobot('robot1')` | success: true | ✅ |
| CM-002 | 连接不存在的机器人 | `connectRobot('unknown')` | success: false | ✅ |
| CM-003 | 机器人占用检查 | 连接已被占用的机器人 | error: robot_occupied | ✅ |
| CM-004 | 断开连接 | `disconnectRobot('robot1')` | 连接断开 | ✅ |
| CM-005 | 获取客户端 | `getClient('robot1')` | 返回 WecomClient | ✅ |
| CM-006 | 重连逻辑 | 断开后调用 getClient | 自动重连 | ✅ |
| CM-007 | 获取所有连接状态 | `getAllConnectionStates()` | 连接列表 | ✅ |
| CM-008 | 更新智能体名称 | `updateAgentName()` | 名称更新 | ✅ |

### 2.5 MCP 工具测试 (tools/index.ts)

**目标覆盖率：90%**

| 用例ID | 场景 | 输入 | 预期输出 | 自动化 |
|--------|------|------|---------|--------|
| T-001 | send_message | content, target_user | 消息发送成功 | ✅ |
| T-002 | send_approval_request | title, description | taskId, status: pending | ✅ |
| T-003 | get_approval_result | task_id | 状态 | ✅ |
| T-004 | check_connection | 无 | 连接状态 | ✅ |
| T-005 | list_robots | 无 | 机器人列表 | ✅ |
| T-006 | enter_headless_mode-单机器人 | agent_name | status: entered, ccId | ✅ |
| T-007 | enter_headless_mode-多机器人 | agent_name | status: select_robot | ✅ |
| T-008 | enter_headless_mode-指定机器人 | agent_name, robot_id | status: entered | ✅ |
| T-009 | enter_headless_mode-机器人占用 | agent_name | error: robot_occupied | ✅ |
| T-010 | exit_headless_mode | 无 | status: exited | ✅ |
| T-011 | detect_user_from_message | timeout | 用户信息 | ✅ |
| T-012 | get_connection_stats | recent_logs | 统计信息 | ✅ |
| T-013 | 未连接时调用工具 | 无 Session | error: 未在微信模式 | ✅ |

### 2.6 多 CC 路由测试

**目标覆盖率：100%**

| 用例ID | 场景 | 输入 | 预期输出 | 自动化 |
|--------|------|------|---------|--------|
| MC-001 | 单 CC 直接推送 | 用户消息，1 个 Session | 消息推送给该 CC | ✅ |
| MC-002 | 多 CC 引用路由 | 引用【cc-1】的消息 | 只有 cc-1 收到 | ✅ |
| MC-003 | 多 CC 无引用 | 无引用的消息 | 机器人提示引用 | ✅ |
| MC-004 | 引用不存在的 ccId | 引用【cc-999】 | 机器人提示 | ✅ |
| MC-005 | 审批卡片 ccId 标识 | 多 CC 同时审批 | 卡片显示 ccId | ✅ |

### 2.7 配置向导测试 (config-wizard.ts)

**目标覆盖率：80%**

| 用例ID | 场景 | 输入 | 预期输出 | 自动化 |
|--------|------|------|---------|--------|
| CW-001 | 首次配置 | 交互输入 | 配置文件生成 | 手动 |
| CW-002 | 添加机器人 | --add | 新机器人配置 | 手动 |
| CW-003 | 删除机器人 | --delete | 配置删除 | 手动 |
| CW-004 | 卸载 | --uninstall | 清理所有配置 | 手动 |
| CW-005 | 列出机器人 | listAllRobots() | 机器人列表 | ✅ |

### 2.8 审批流程测试

**目标覆盖率：85%**

| 用例ID | 场景 | 输入 | 预期输出 | 自动化 |
|--------|------|------|---------|--------|
| AP-001 | 发送审批卡片 | Hook 调用 /approve | 卡片发送成功 | ✅ |
| AP-002 | 用户允许 | 点击"允许"按钮 | 状态更新为 allow-once | ✅ |
| AP-003 | 用户拒绝 | 点击"拒绝"按钮 | 状态更新为 deny | ✅ |
| AP-004 | 审批超时 | 10 分钟无操作 | 自动拒绝 | ✅ |
| AP-005 | Hook 轮询 | GET /approval_status | 返回当前状态 | ✅ |

---

## 三、测试实施计划

### Phase 1：单元测试（自动化）

**工具**：Vitest + @vitest/coverage-v8

```bash
npm install -D vitest @vitest/coverage-v8
```

**测试文件结构**：

```
tests/
├── unit/
│   ├── message-bus.test.ts
│   ├── client.test.ts
│   ├── http-server.test.ts
│   ├── connection-manager.test.ts
│   └── tools.test.ts
├── integration/
│   ├── message-flow.test.ts
│   ├── approval-flow.test.ts
│   └── multi-cc-routing.test.ts
└── e2e/
    └── full-scenario.test.ts
```

### Phase 2：集成测试

| 测试项 | 方法 | 环境 |
|--------|------|------|
| WebSocket 连接 | Mock SDK | 本地 |
| MCP 协议 | HTTP Client | 本地 |
| 消息路由 | 多 Session 模拟 | 本地 |

### Phase 3：端到端测试

| 测试项 | 方法 | 环境 |
|--------|------|------|
| 完整流程 | 真实机器人 | 测试环境 |
| 审批流程 | 真实微信 | 测试环境 |

---

## 四、测试代码示例

### 4.1 消息总线测试

```typescript
// tests/unit/message-bus.test.ts
import { describe, it, expect, vi } from 'vitest';
import { publishWecomMessage, subscribeWecomMessage, subscribeWecomMessageByRobot } from '../src/message-bus.js';

describe('MessageBus', () => {
  it('should publish and receive message', () => {
    const callback = vi.fn();
    subscribeWecomMessage(callback);
    
    publishWecomMessage({
      robotName: 'test',
      msgid: '123',
      content: 'hello',
      from_userid: 'user1',
      chatid: 'user1',
      chattype: 'single',
      timestamp: Date.now(),
    });
    
    expect(callback).toHaveBeenCalledTimes(1);
  });
  
  it('should filter by robot name', () => {
    const callback = vi.fn();
    subscribeWecomMessageByRobot('robot1', callback);
    
    publishWecomMessage({
      robotName: 'robot2',
      msgid: '123',
      content: 'hello',
      from_userid: 'user1',
      chatid: 'user1',
      chattype: 'single',
      timestamp: Date.now(),
    });
    
    expect(callback).not.toHaveBeenCalled();
  });
});
```

### 4.2 引用路由测试

```typescript
// tests/integration/multi-cc-routing.test.ts
import { describe, it, expect, beforeEach } from 'vitest';

describe('Multi-CC Routing', () => {
  it('should route to cc-1 when quote contains cc-1', () => {
    const ccId = extractCcIdFromQuote('【cc-1】已进入微信模式...');
    expect(ccId).toBe('cc-1');
  });
  
  it('should return null for no quote', () => {
    const ccId = extractCcIdFromQuote(undefined);
    expect(ccId).toBeNull();
  });
  
  it('should push directly when only one CC online', () => {
    // 模拟单 CC 场景
    sessionStore.set('session1', { ccId: 'cc-1', robotName: 'test' });
    
    const msg = { quoteContent: undefined, ... };
    handleWecomMessage(msg);
    
    // 验证推送
    expect(pushMessageToSession).toHaveBeenCalled();
  });
});
```

---

## 五、覆盖率目标

| 模块 | 目标 | 当前 | 状态 |
|------|------|------|------|
| message-bus.ts | 95% | - | 待测试 |
| client.ts | 90% | - | 待测试 |
| http-server.ts | 85% | - | 待测试 |
| connection-manager.ts | 85% | - | 待测试 |
| tools/index.ts | 90% | - | 待测试 |
| config-wizard.ts | 80% | - | 待测试 |
| **总体** | **85%** | - | 待测试 |

---

## 六、测试执行命令

```bash
# 运行所有测试
npm test

# 运行单元测试
npm run test:unit

# 运行集成测试
npm run test:integration

# 生成覆盖率报告
npm run test:coverage
```

---

## 七、持续集成

```yaml
# .github/workflows/test.yml
name: Test
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
      - run: npm ci
      - run: npm run build
      - run: npm run test:coverage
      - uses: codecov/codecov-action@v3
```

---

## 八、测试报告

每次测试完成后生成：

1. **覆盖率报告**：HTML + JSON
2. **测试结果**：通过的用例数、失败的用例数
3. **性能指标**：测试执行时间

---

## 九、验收标准

| 指标 | 目标 | 说明 |
|------|------|------|
| 代码覆盖率 | ≥ 85% | 行覆盖率 |
| 分支覆盖率 | ≥ 80% | 分支覆盖 |
| 测试通过率 | 100% | 所有测试用例通过 |
| 关键路径覆盖 | 100% | 用户消息流、审批流程 |