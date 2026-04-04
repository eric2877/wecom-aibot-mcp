# 企业微信智能机器人接入指南
**Using Claude Code as Your AI Bot Backend**

> 适用版本：企业微信智能机器人长连接 API（2026）
> Node.js SDK：`@wecom/aibot-node-sdk`

---

## 1. 概述

本文档指导开发者将 Claude Code（或任意基于 Anthropic Claude API 的应用）以智能机器人身份接入企业微信，实现单聊、群聊 @ 回复、流式消息等功能。

### 1.1 接入方式对比

企业微信智能机器人支持两种 API 模式：

| 特性 | Webhook（短连接） | WebSocket（长连接） |
|------|------------------|-------------------|
| 连接方式 | 每次回调建立新连接 | 复用已建立的长连接 |
| 实时性 | 一般 | 高（低延迟） |
| 服务端要求 | 需公网可访问的 URL | **无需固定公网 IP** |
| 消息加解密 | 需要 | **无需** |
| 心跳维护 | 不需要 | 需要（建议每 30 秒） |
| 断线重连 | 不需要 | 需要实现 |
| 推荐场景 | 有固定公网 IP | 内网部署、高实时性、开发调试 |

> 💡 **推荐使用长连接模式**：无需公网 IP、无需加解密、更低延迟，非常适合 Claude Code 本地或内网部署。

### 1.2 整体交互流程

1. 开发者服务使用 BotID 和 Secret 向企业微信发起 WebSocket 连接（`aibot_subscribe`）
2. 连接成功后保持长连接，等待事件推送
3. 用户进入机器人会话时，触发 `enter_chat` 事件，可回复欢迎语
4. 用户在群聊 @ 机器人或单聊发消息，触发 `aibot_msg_callback`
5. 开发者调用 Claude API 生成回答，通过长连接流式推送（`finish=true` 结束）
6. 用户点击模板卡片按钮时，触发 `template_card_event`，可更新卡片内容
7. 开发者每 30 秒发送 `ping` 保持连接活跃

---

## 2. 前置准备

### 2.1 企业微信后台配置

1. 登录企业微信管理后台（work.weixin.qq.com/wework_admin）
2. 进入 **管理工具 → 智能机器人**
3. 点击「创建机器人」→「手动创建」
4. 填写机器人名称、简介、可见范围
5. 在「API 配置」区域，连接方式选择「**使用长连接**」
6. 在「Secret」区域点击「点击获取」，保存 **Bot ID** 和 **Secret**

> ⚠️ **注意**：Secret 是长连接专用密钥，与 Webhook 模式的 Token/EncodingAESKey 不同。请妥善保管，避免泄露。每个机器人同一时间只能保持一个有效长连接。

### 2.2 所需凭证

| 凭证名称 | 说明 | 用途 |
|---------|------|------|
| Bot ID | 智能机器人唯一标识 | 建立 WebSocket 连接时作为身份标识 |
| Secret | 长连接专用密钥 | 订阅请求（aibot_subscribe）的身份校验 |
| Anthropic API Key | Claude API 密钥 | 调用 Claude 生成回复 |

### 2.3 环境要求

- Node.js >= 16
- 可访问 `wss://openws.work.weixin.qq.com`（企业微信 WebSocket 服务）
- 可访问 `api.anthropic.com`（Anthropic Claude API）

---

## 3. 快速开始（5 分钟接入）

### 3.1 安装依赖

```bash
# 初始化项目
mkdir wecom-claude-bot && cd wecom-claude-bot
npm init -y

# 安装企业微信官方 SDK
npm install @wecom/aibot-node-sdk

# 安装 Anthropic SDK
npm install @anthropic-ai/sdk

# 安装其他依赖
npm install dotenv
```

### 3.2 配置环境变量

创建 `.env` 文件：

```env
WECOM_BOT_ID=your_bot_id_here
WECOM_SECRET=your_secret_here
ANTHROPIC_API_KEY=sk-ant-xxxxxxxxxxxxx
```

> ⚠️ 请将 `.env` 加入 `.gitignore`，避免密钥泄露到代码仓库。

### 3.3 核心代码实现

创建主入口文件 `bot.js`：

```javascript
require('dotenv').config();
const { AibotClient } = require('@wecom/aibot-node-sdk');
const Anthropic = require('@anthropic-ai/sdk');

const client = new AibotClient({
  botId: process.env.WECOM_BOT_ID,
  secret: process.env.WECOM_SECRET,
});

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// ── 1. 建立长连接 ──────────────────────────────────────────
client.connect();

// ── 2. 处理用户消息（单聊 + 群聊 @）─────────────────────────
client.on('message', async (msg) => {
  const userText = extractText(msg);
  if (!userText) return;

  console.log(`[收到消息] ${msg.from.userid}: ${userText}`);

  try {
    await replyWithClaude(client, msg, userText);
  } catch (err) {
    console.error('[错误]', err);
    await client.replyText(msg, '抱歉，处理您的请求时出现错误，请稍后重试。');
  }
});

// ── 3. 处理进入会话事件（发送欢迎语）──────────────────────
client.on('enter_chat', async (event) => {
  await client.replyWelcome(event, {
    msgtype: 'text',
    text: { content: '您好！我是 Claude AI 助手，有什么可以帮您的吗？' }
  });
});

// ── 4. 流式调用 Claude 并推送消息 ─────────────────────────
async function replyWithClaude(client, msg, userText) {
  const streamId = `stream_${Date.now()}`;
  let fullText = '';

  const stream = await anthropic.messages.stream({
    model: 'claude-opus-4-6',
    max_tokens: 2048,
    messages: [{ role: 'user', content: userText }]
  });

  for await (const chunk of stream) {
    if (chunk.type === 'content_block_delta' &&
        chunk.delta.type === 'text_delta') {
      fullText += chunk.delta.text;

      // 推送流式更新（未完成）
      await client.replyStream(msg, {
        streamId,
        content: fullText,
        finish: false
      });
    }
  }

  // 发送最终消息（标记 finish=true）
  await client.replyStream(msg, {
    streamId,
    content: fullText,
    finish: true
  });
}

// ── 5. 提取消息文本内容 ────────────────────────────────────
function extractText(msg) {
  if (msg.msgtype === 'text') return msg.text?.content || '';
  if (msg.msgtype === 'mixed') {
    return (msg.mixed?.items || [])
      .filter(i => i.type === 'text')
      .map(i => i.text?.content || '')
      .join('');
  }
  return '';
}

console.log('企业微信 Claude 机器人已启动...');
```

### 3.4 启动机器人

```bash
node bot.js

# 或使用 pm2 保持后台运行
npm install -g pm2
pm2 start bot.js --name wecom-claude-bot
pm2 logs wecom-claude-bot
```

---

## 4. 长连接 API 详解

### 4.1 建立 WebSocket 连接

WebSocket 服务端地址：

```
wss://openws.work.weixin.qq.com
```

连接建立后，需立即发送订阅请求：

```json
{
  "cmd": "aibot_subscribe",
  "headers": { "req_id": "唯一请求ID" },
  "body": {
    "bot_id": "YOUR_BOT_ID",
    "secret": "YOUR_SECRET"
  }
}
```

成功响应：

```json
{
  "headers": { "req_id": "唯一请求ID" },
  "errcode": 0,
  "errmsg": "ok"
}
```

> ⚠️ 订阅请求有频率保护，订阅成功后避免反复发送。同一机器人同时只能保持一个有效连接，新连接会踢掉旧连接。

### 4.2 接收消息回调

用户发消息时，企业微信推送 `aibot_msg_callback`：

```json
{
  "cmd": "aibot_msg_callback",
  "headers": { "req_id": "REQUEST_ID" },
  "body": {
    "msgid": "消息唯一ID（用于去重）",
    "aibotid": "BOT_ID",
    "chatid": "群聊ID（仅群聊时存在）",
    "chattype": "single|group",
    "from": { "userid": "发送者userid" },
    "msgtype": "text",
    "text": { "content": "@机器人 你好" }
  }
}
```

支持的消息类型：

| msgtype | 说明 | 支持场景 |
|---------|------|---------|
| `text` | 文本消息 | 单聊 + 群聊 |
| `image` | 图片消息 | 仅单聊 |
| `mixed` | 图文混排消息 | 单聊 + 群聊 |
| `voice` | 语音消息（转文本） | 仅单聊 |
| `file` | 文件消息 | 仅单聊 |

### 4.3 接收事件回调

| eventtype | 触发时机 | 可回复命令 |
|-----------|---------|-----------|
| `enter_chat` | 用户当天首次进入机器人单聊会话 | `aibot_respond_welcome_msg` |
| `template_card_event` | 用户点击模板卡片按钮 | `aibot_respond_update_msg` |
| `feedback_event` | 用户对机器人回复进行反馈 | — |
| `disconnected_event` | 新连接建立导致旧连接被踢 | 需重新连接 |

### 4.4 将机器人拉入群聊

智能机器人支持被拉入群聊，群成员 @ 机器人即可触发消息回调，适合作为团队共享的 AI 助手。

**群聊支持的能力**

| 能力 | 是否支持 |
|------|---------|
| 被 @ 后回复文本消息 | ✅ |
| 被 @ 后回复图文混排消息 | ✅ |
| 机器人主动向群推送消息 | ✅ |
| 接收群成员发送的图片/语音/文件 | ❌（仅单聊支持） |

> ⚠️ 群聊中只有被 @ 时才触发回调，机器人不会收到其他成员的普通聊天消息。

**通过 chattype 区分单聊与群聊**

收到消息回调时，通过 `chattype` 字段判断来源，`chatid` 为群聊 ID：

```javascript
client.on('message', async (msg) => {
  const isGroup = msg.body.chattype === 'group';
  const chatId = msg.body.chatid; // 群聊 ID，单聊时不存在

  if (isGroup) {
    console.log(`来自群聊 ${chatId} 的消息`);
  } else {
    console.log(`来自单聊的消息`);
  }

  // 回复逻辑相同，企业微信自动将回复发到对应会话
  const userText = extractText(msg);
  await replyWithClaude(client, msg, userText);
});
```

**主动向群推送消息**

无需用户触发，可通过 `aibot_send_msg` 主动向群发送消息，适合定时提醒、任务通知等场景：

```javascript
send({
  cmd: 'aibot_send_msg',
  headers: { req_id: uuidv4() },
  body: {
    chattype: 'group',
    chatid: '目标群聊ID',
    msgtype: 'text',
    text: { content: '这是一条主动推送的消息' }
  }
});
```

**发送频率限制**

无论是回复消息还是主动推送，同一会话的限制为 30 条/分钟，1000 条/小时。

### 4.5 流式消息回复

长连接模式下，开发者主动推送流式更新（无需等待回调），通过 `stream.id` 关联同一条消息：

```json
// 第一次推送：创建流式消息
{
  "cmd": "aibot_respond_msg",
  "headers": { "req_id": "透传消息回调的req_id" },
  "body": {
    "msgtype": "stream",
    "stream": {
      "id": "唯一stream_id",
      "content": "正在思考",
      "finish": false
    }
  }
}

// 后续推送：使用相同 stream.id 更新内容
// ...

// 最后一次推送：结束流式消息
{
  "body": {
    "stream": {
      "id": "相同stream_id",
      "content": "完整回答内容",
      "finish": true
    }
  }
}
```

> ⚠️ 流式消息从首次发送起，必须在 **6 分钟内**完成所有更新并设置 `finish=true`，否则消息将自动结束。

### 4.6 心跳保活

每 30 秒发送一次 `ping`：

```json
// 发送
{ "cmd": "ping", "headers": { "req_id": "PING_ID" } }

// 响应
{ "cmd": "pong", "headers": { "req_id": "PING_ID" }, "errcode": 0 }
```

```javascript
setInterval(() => {
  ws.send(JSON.stringify({
    cmd: 'ping',
    headers: { req_id: `ping_${Date.now()}` }
  }));
}, 30 * 1000);
```

---

## 5. 生产级完整实现

### 5.1 带断线重连的完整 bot.js

```javascript
require('dotenv').config();
const WebSocket = require('ws');
const Anthropic = require('@anthropic-ai/sdk');
const { v4: uuidv4 } = require('uuid');

const BOT_ID = process.env.WECOM_BOT_ID;
const SECRET = process.env.WECOM_SECRET;
const WS_URL = 'wss://openws.work.weixin.qq.com';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

let ws = null;
let heartbeatTimer = null;
let reconnectTimer = null;

function connect() {
  console.log('[连接] 正在连接企业微信...');
  ws = new WebSocket(WS_URL);

  ws.on('open', () => {
    console.log('[连接] WebSocket 已建立，发送订阅请求...');
    subscribe();
    startHeartbeat();
  });

  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    handleMessage(msg);
  });

  ws.on('close', (code) => {
    console.log(`[断线] code=${code}，5秒后重连...`);
    stopHeartbeat();
    scheduleReconnect();
  });

  ws.on('error', (err) => {
    console.error('[错误]', err.message);
  });
}

function subscribe() {
  send({
    cmd: 'aibot_subscribe',
    headers: { req_id: uuidv4() },
    body: { bot_id: BOT_ID, secret: SECRET }
  });
}

function startHeartbeat() {
  heartbeatTimer = setInterval(() => {
    send({ cmd: 'ping', headers: { req_id: uuidv4() } });
  }, 30000);
}

function stopHeartbeat() {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, 5000);
}

function send(obj) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

async function handleMessage(msg) {
  switch (msg.cmd) {
    case 'aibot_msg_callback':  await onUserMessage(msg); break;
    case 'aibot_event_callback': await onEvent(msg); break;
    case 'pong': break; // 心跳响应，忽略
  }
}

async function onUserMessage(msg) {
  const text = msg.body?.text?.content || '';
  if (!text.trim()) return;

  const reqId = msg.headers?.req_id;
  const streamId = uuidv4();
  let fullText = '';

  const stream = await anthropic.messages.stream({
    model: 'claude-opus-4-6',
    max_tokens: 2048,
    messages: [{ role: 'user', content: text }]
  });

  for await (const chunk of stream) {
    if (chunk.type === 'content_block_delta' &&
        chunk.delta.type === 'text_delta') {
      fullText += chunk.delta.text;
      send({
        cmd: 'aibot_respond_msg',
        headers: { req_id: reqId },
        body: { msgtype: 'stream', stream: { id: streamId, content: fullText, finish: false } }
      });
    }
  }

  send({
    cmd: 'aibot_respond_msg',
    headers: { req_id: reqId },
    body: { msgtype: 'stream', stream: { id: streamId, content: fullText, finish: true } }
  });
}

async function onEvent(msg) {
  const eventType = msg.body?.event?.eventtype;
  if (eventType === 'enter_chat') {
    send({
      cmd: 'aibot_respond_welcome_msg',
      headers: { req_id: msg.headers?.req_id },
      body: { msgtype: 'text', text: { content: '您好！我是 Claude AI 助手，有什么可以帮您？' } }
    });
  } else if (eventType === 'disconnected_event') {
    console.log('[踢出] 旧连接被踢，等待重连...');
  }
}

connect();
```

### 5.2 使用官方 SDK（推荐）

企业微信提供了官方 Node.js SDK，已封装心跳、重连等底层逻辑，推荐优先使用：

```bash
npm install @wecom/aibot-node-sdk
# 官方 npm 包：https://www.npmjs.com/package/@wecom/aibot-node-sdk
```

SDK 文档详见：https://developer.work.weixin.qq.com/document/path/101463

---

## 6. 常见问题与排查

| 问题 | 可能原因 | 解决方案 |
|------|---------|---------|
| 连接成功但收不到消息 | 机器人未添加到会话/群聊 | 确认用户已与机器人开始对话或在群里 @ 机器人 |
| 订阅返回 errcode 非 0 | Bot ID 或 Secret 错误 | 在管理后台重新获取凭证，确认粘贴完整 |
| 长连接频繁断开 | 心跳未正确实现 | 确保每 30 秒发送一次 ping |
| 新连接建立后旧连接断开 | 同一机器人多实例运行 | 确保只有一个进程连接，使用主备切换代替多连接 |
| 流式消息不显示 | 未在 6 分钟内设置 finish=true | 检查流式消息发送逻辑，确保最终设置 finish=true |
| Claude API 响应超时 | 网络问题或 API 限流 | 增加超时时间，实现重试逻辑 |
| 群聊无法收到消息 | 机器人未被 @ 或权限未配置 | 群聊仅在被 @ 时触发，检查机器人可见范围设置 |

---

## 7. 安全建议

- 将 Bot ID、Secret、Anthropic API Key 存储在环境变量或密钥管理服务中，不要硬编码在代码里
- 使用 `.gitignore` 排除 `.env` 文件
- 定期轮换 Anthropic API Key
- 实现消息去重（利用 `msgid` 字段），避免重复处理
- 对用户输入进行基本过滤，防止 prompt injection
- 生产环境使用 `pm2` 或 `systemd` 管理进程，并配置日志轮转
- 如需多实例高可用，采用主备切换模式，而非同时多连接

---

## 8. 参考资料

- [企业微信智能机器人长连接文档](https://developer.work.weixin.qq.com/document/path/101463)
- [企业微信智能机器人概述](https://developer.work.weixin.qq.com/document/path/101039)
- [接收消息文档](https://developer.work.weixin.qq.com/document/path/100719)
- [官方 Node.js SDK](https://www.npmjs.com/package/@wecom/aibot-node-sdk)
- [Anthropic Claude API 文档](https://docs.anthropic.com)

---

*文档版本：2026 | 基于企业微信智能机器人长连接 API*
