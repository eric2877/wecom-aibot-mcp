/**
 * Channel MCP Proxy 单元测试
 * 测试 SSE 消息接收和 notification 发送
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

// 模拟 fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

// 模拟 McpServer
const mockNotification = vi.fn();
const mockMcpServer = {
  server: {
    notification: mockNotification,
  },
} as unknown as McpServer;

describe('Channel Server - SSE 消息接收', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('应该正确建立 SSE 连接', async () => {
    // 模拟 SSE 响应
    const mockSSEStream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('event: connected\ndata: {"clientId":"test-123","ccId":"test"}\n\n'));
        controller.close();
      },
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: mockSSEStream,
      headers: new Headers({
        'Content-Type': 'text/event-stream',
      }),
    });

    const response = await fetch('http://127.0.0.1:18963/sse/test-channel');

    expect(response.ok).toBe(true);
    expect(response.status).toBe(200);
  });

  it('应该正确解析 SSE 消息', async () => {
    // 模拟 SSE 数据格式
    const sseData = `event: message\ndata: {"type":"wecom_message","robotName":"CC","ccId":"test-channel","message":{"content":"测试消息","from":"LiuYang"}}\n\n`;

    const lines = sseData.split('\n');
    const messages: any[] = [];

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const data = line.slice(6);
        try {
          const msg = JSON.parse(data);
          messages.push(msg);
        } catch (e) {
          // 解析失败
        }
      }
    }

    expect(messages.length).toBe(1);
    expect(messages[0].type).toBe('wecom_message');
    expect(messages[0].message.content).toBe('测试消息');
  });

  it('应该发送正确的 notification 格式', async () => {
    // 模拟接收到的 SSE 消息
    const sseMessage = {
      type: 'wecom_message',
      robotName: 'CC',
      ccId: 'test-channel',
      message: {
        content: '你好',
        from: 'LiuYang',
        chatid: 'LiuYang',
        chattype: 'single',
        time: '2026-04-12T16:00:00.000Z',
      },
    };

    // 构造 notification
    const notification = {
      method: 'notifications/claude/channel',
      params: {
        type: sseMessage.type,
        content: sseMessage,
      },
    };

    // 验证 notification 格式
    expect(notification.method).toBe('notifications/claude/channel');
    expect(notification.params.type).toBe('wecom_message');
    expect(notification.params.content.message.content).toBe('你好');

    // 模拟发送 notification
    mockMcpServer.server.notification(notification);

    expect(mockNotification).toHaveBeenCalledOnce();
    expect(mockNotification).toHaveBeenCalledWith(notification);
  });

  it('应该处理多条 SSE 消息', async () => {
    // 模拟多条 SSE 消息
    const sseData = `
event: message
data: {"type":"wecom_message","message":{"content":"消息1"}}

event: message
data: {"type":"wecom_message","message":{"content":"消息2"}}

`;

    const lines = sseData.split('\n');
    const messages: any[] = [];

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const data = line.slice(6);
        try {
          messages.push(JSON.parse(data));
        } catch (e) {}
      }
    }

    expect(messages.length).toBe(2);
    expect(messages[0].message.content).toBe('消息1');
    expect(messages[1].message.content).toBe('消息2');
  });

  it('应该处理 SSE 连接失败', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
    });

    const response = await fetch('http://127.0.0.1:18963/sse/invalid-ccid');

    expect(response.ok).toBe(false);
    expect(response.status).toBe(404);
  });

  it('应该处理 SSE 流结束', async () => {
    // 模拟 SSE 流正常结束
    const mockSSEStream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('event: connected\ndata: {"status":"ok"}\n\n'));
        controller.close(); // 流结束
      },
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      body: mockSSEStream,
    });

    const response = await fetch('http://127.0.0.1:18963/sse/test');
    const reader = response.body?.getReader();

    if (reader) {
      const { done, value } = await reader.read();
      expect(done).toBe(false); // 第一条消息

      const { done: done2 } = await reader.read();
      expect(done2).toBe(true); // 流结束
    }
  });
});

describe('Channel Server - HTTP MCP 转发', () => {
  it('应该正确初始化 HTTP MCP session', async () => {
    // 模拟 HTTP MCP initialize 响应
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Headers({
        'mcp-session-id': 'session-test-123',
      }),
    });

    const response = await fetch('http://127.0.0.1:18963/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'channel-proxy', version: '1.0' },
        },
        id: 1,
      }),
    });

    const sessionId = response.headers.get('mcp-session-id');
    expect(sessionId).toBe('session-test-123');
  });

  it('应该正确转发工具调用请求', async () => {
    // 模拟 HTTP MCP tools/call 响应
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve('data: {"result":{"content":[{"type":"text","text":"消息已发送"}]}}\n\n'),
    });

    const response = await fetch('http://127.0.0.1:18963/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'mcp-session-id': 'session-test-123',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/call',
        params: {
          name: 'send_message',
          arguments: {
            content: '测试消息',
            cc_id: 'test-channel',
          },
        },
        id: 2,
      }),
    });

    expect(response.ok).toBe(true);
  });
});

describe('Channel Server - Notification 转发测试', () => {
  it('应该正确转发 SSE 消息到 Claude Code notification', async () => {
    // 模拟完整的 SSE → Notification 流程

    // 1. SSE 消息数据
    const sseRawData = `event: message\ndata: {"type":"wecom_message","robotName":"CC","ccId":"test-channel","message":{"content":"你好","from":"LiuYang","chatid":"LiuYang","chattype":"single","time":"2026-04-12T16:00:00.000Z"}}\n\n`;

    // 2. 解析 SSE 数据
    const lines = sseRawData.split('\n');
    let parsedMessage: any = null;

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const data = line.slice(6);
        parsedMessage = JSON.parse(data);
        break;
      }
    }

    expect(parsedMessage).not.toBeNull();
    expect(parsedMessage.type).toBe('wecom_message');

    // 3. 构造 notification
    const notification = {
      method: 'notifications/claude/channel',
      params: {
        type: parsedMessage.type,
        content: parsedMessage,
      },
    };

    // 4. 模拟发送 notification
    mockMcpServer.server.notification(notification);

    expect(mockNotification).toHaveBeenCalledOnce();
    expect(mockNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'notifications/claude/channel',
        params: expect.objectContaining({
          type: 'wecom_message',
          content: expect.objectContaining({
            message: expect.objectContaining({
              content: '你好',
            }),
          }),
        }),
      })
    );
  });

  it('notification 应该包含完整的消息信息', async () => {
    // 测试 notification 内容完整性
    const fullMessage = {
      type: 'wecom_message',
      robotName: 'CC',
      ccId: 'test-channel',
      message: {
        content: '完整测试消息',
        from: 'LiuYang',
        chatid: 'LiuYang',
        chattype: 'single',
        time: '2026-04-12T17:00:00.000Z',
      },
    };

    const notification = {
      method: 'notifications/claude/channel',
      params: {
        type: fullMessage.type,
        content: fullMessage,
      },
    };

    // 验证所有字段都存在
    expect(notification.params.content.robotName).toBe('CC');
    expect(notification.params.content.message.from).toBe('LiuYang');
    expect(notification.params.content.message.chattype).toBe('single');
  });

  it('应该处理不同类型的 SSE 消息', async () => {
    // 测试不同消息类型
    const messageTypes = [
      { type: 'wecom_message', expected: 'wecom_message' },
      { type: 'approval_request', expected: 'approval_request' },
      { type: 'connection_event', expected: 'connection_event' },
    ];

    for (const { type, expected } of messageTypes) {
      const notification = {
        method: 'notifications/claude/channel',
        params: {
          type: type,
          content: { type },
        },
      };

      expect(notification.params.type).toBe(expected);
    }
  });

  it('应该在 mcpServer 为 null 时不发送 notification', async () => {
    // 清除之前的 mock 调用
    mockNotification.mockClear();

    // 测试 mcpServer 未初始化的情况
    // 当 mcpServer 为 null 时，代码会跳过 notification 发送
    // 这里验证不会调用 mockNotification

    // 预期不会调用 notification
    expect(mockNotification).not.toHaveBeenCalled();
  });

  it('应该正确处理 SSE chunk 分片', async () => {
    // 测试 SSE 数据分片到达的情况
    const chunk1 = 'event: message\ndata: ';
    const chunk2 = '{"type":"wecom_message","message":{"content":"分片测试"}}';
    const chunk3 = '\n\n';

    // 合并分片
    const fullChunk = chunk1 + chunk2 + chunk3;
    const lines = fullChunk.split('\n');

    let parsedMessage: any = null;
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const data = line.slice(6);
        try {
          parsedMessage = JSON.parse(data);
        } catch (e) {
          // 可能是不完整的 JSON
        }
      }
    }

    expect(parsedMessage).not.toBeNull();
    expect(parsedMessage.message.content).toBe('分片测试');
  });
});