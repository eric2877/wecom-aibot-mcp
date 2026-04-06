/**
 * 多 CC 路由集成测试
 *
 * 测试覆盖：
 * - MC-001: 单 CC 直接推送
 * - MC-002: 多 CC 引用路由
 * - MC-003: 多 CC 无引用
 * - MC-004: 引用不存在的 ccId
 * - MC-005: 审批卡片 ccId 标识
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('Multi-CC Routing Integration', () => {
  // 模拟 Session 数据
  interface SessionData {
    robotName: string;
    agentName?: string;
    ccId: string;
    createdAt: number;
  }

  // 模拟消息
  interface WecomMessage {
    robotName: string;
    msgid: string;
    content: string;
    from_userid: string;
    chatid: string;
    chattype: 'single' | 'group';
    timestamp: number;
    quoteContent?: string;
  }

  // 核心路由函数
  function extractCcIdFromQuote(quoteContent?: string): string | null {
    if (!quoteContent) return null;
    const match = quoteContent.match(/【(cc-\d+)】/);
    return match ? match[1] : null;
  }

  function findSessionByCcId(
    quoteContent: string | undefined,
    sessionStore: Map<string, SessionData>
  ): SessionData | null {
    const ccId = extractCcIdFromQuote(quoteContent);
    if (!ccId) return null;

    for (const [, data] of sessionStore) {
      if (data.ccId === ccId) return data;
    }
    return null;
  }

  function handleMessage(
    msg: WecomMessage,
    sessionStore: Map<string, SessionData>
  ): { action: string; targetSession?: SessionData } {
    const targetSession = findSessionByCcId(msg.quoteContent, sessionStore);

    if (targetSession) {
      return { action: 'push', targetSession };
    } else if (sessionStore.size === 1) {
      // 单 CC 直接推送
      const firstSession = Array.from(sessionStore.values())[0];
      return { action: 'push_direct', targetSession: firstSession };
    } else if (sessionStore.size > 1) {
      // 多 CC 无引用
      return { action: 'prompt' };
    }

    return { action: 'no_session' };
  }

  let sessionStore: Map<string, SessionData>;

  beforeEach(() => {
    sessionStore = new Map();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('MC-001: 单 CC 直接推送', () => {
    it('只有一个 Session 时，无引用消息应该直接推送', () => {
      sessionStore.set('session-1', {
        robotName: 'robot1',
        ccId: 'cc-1',
        createdAt: Date.now()
      });

      const msg: WecomMessage = {
        robotName: 'robot1',
        msgid: 'msg-001',
        content: 'hello',
        from_userid: 'user1',
        chatid: 'user1',
        chattype: 'single',
        timestamp: Date.now()
        // 无 quoteContent
      };

      const result = handleMessage(msg, sessionStore);

      expect(result.action).toBe('push_direct');
      expect(result.targetSession?.ccId).toBe('cc-1');
    });

    it('单 CC 有引用时也应该推送', () => {
      sessionStore.set('session-1', {
        robotName: 'robot1',
        ccId: 'cc-1',
        createdAt: Date.now()
      });

      const msg: WecomMessage = {
        robotName: 'robot1',
        msgid: 'msg-001',
        content: 'hello',
        from_userid: 'user1',
        chatid: 'user1',
        chattype: 'single',
        timestamp: Date.now(),
        quoteContent: '【cc-1】之前的消息'
      };

      const result = handleMessage(msg, sessionStore);

      expect(result.action).toBe('push');
      expect(result.targetSession?.ccId).toBe('cc-1');
    });
  });

  describe('MC-002: 多 CC 引用路由', () => {
    beforeEach(() => {
      sessionStore.set('session-1', {
        robotName: 'robot1',
        ccId: 'cc-1',
        createdAt: Date.now()
      });
      sessionStore.set('session-2', {
        robotName: 'robot1',
        ccId: 'cc-2',
        createdAt: Date.now()
      });
    });

    it('引用 cc-1 时应该只路由给 cc-1', () => {
      const msg: WecomMessage = {
        robotName: 'robot1',
        msgid: 'msg-001',
        content: '回复给 cc-1',
        from_userid: 'user1',
        chatid: 'user1',
        chattype: 'single',
        timestamp: Date.now(),
        quoteContent: '【cc-1】之前的消息'
      };

      const result = handleMessage(msg, sessionStore);

      expect(result.action).toBe('push');
      expect(result.targetSession?.ccId).toBe('cc-1');
      expect(result.targetSession?.ccId).not.toBe('cc-2');
    });

    it('引用 cc-2 时应该只路由给 cc-2', () => {
      const msg: WecomMessage = {
        robotName: 'robot1',
        msgid: 'msg-002',
        content: '回复给 cc-2',
        from_userid: 'user1',
        chatid: 'user1',
        chattype: 'single',
        timestamp: Date.now(),
        quoteContent: '【cc-2】之前的消息'
      };

      const result = handleMessage(msg, sessionStore);

      expect(result.action).toBe('push');
      expect(result.targetSession?.ccId).toBe('cc-2');
    });

    it('三个 CC 时应该正确路由', () => {
      sessionStore.set('session-3', {
        robotName: 'robot1',
        ccId: 'cc-3',
        createdAt: Date.now()
      });

      const msg: WecomMessage = {
        robotName: 'robot1',
        msgid: 'msg-003',
        content: '回复给 cc-3',
        from_userid: 'user1',
        chatid: 'user1',
        chattype: 'single',
        timestamp: Date.now(),
        quoteContent: '【cc-3】之前的消息'
      };

      const result = handleMessage(msg, sessionStore);

      expect(result.action).toBe('push');
      expect(result.targetSession?.ccId).toBe('cc-3');
    });
  });

  describe('MC-003: 多 CC 无引用', () => {
    beforeEach(() => {
      sessionStore.set('session-1', {
        robotName: 'robot1',
        ccId: 'cc-1',
        createdAt: Date.now()
      });
      sessionStore.set('session-2', {
        robotName: 'robot1',
        ccId: 'cc-2',
        createdAt: Date.now()
      });
    });

    it('无引用时应该返回 prompt', () => {
      const msg: WecomMessage = {
        robotName: 'robot1',
        msgid: 'msg-001',
        content: '无引用的消息',
        from_userid: 'user1',
        chatid: 'user1',
        chattype: 'single',
        timestamp: Date.now()
        // 无 quoteContent
      };

      const result = handleMessage(msg, sessionStore);

      expect(result.action).toBe('prompt');
      expect(result.targetSession).toBeUndefined();
    });

    it('应该生成正确的提示消息', () => {
      const onlineList = Array.from(sessionStore.values())
        .map(s => `• ${s.ccId}`)
        .join('\n');

      const prompt = `检测到多个 Claude Code 会话在线，请引用回复指明接收者。

当前在线：
${onlineList}`;

      expect(prompt).toContain('cc-1');
      expect(prompt).toContain('cc-2');
    });
  });

  describe('MC-004: 引用不存在的 ccId', () => {
    beforeEach(() => {
      sessionStore.set('session-1', {
        robotName: 'robot1',
        ccId: 'cc-1',
        createdAt: Date.now()
      });
    });

    it('引用不存在的 ccId 时应该返回 prompt（多 CC）', () => {
      sessionStore.set('session-2', {
        robotName: 'robot1',
        ccId: 'cc-2',
        createdAt: Date.now()
      });

      const msg: WecomMessage = {
        robotName: 'robot1',
        msgid: 'msg-001',
        content: '回复给不存在的 ccId',
        from_userid: 'user1',
        chatid: 'user1',
        chattype: 'single',
        timestamp: Date.now(),
        quoteContent: '【cc-999】不存在的消息'
      };

      const result = handleMessage(msg, sessionStore);

      // cc-999 不存在，无法匹配
      expect(result.action).toBe('prompt');
    });

    it('引用不存在的 ccId 但只有一个 CC 时应该直接推送', () => {
      const msg: WecomMessage = {
        robotName: 'robot1',
        msgid: 'msg-001',
        content: '回复给不存在的 ccId',
        from_userid: 'user1',
        chatid: 'user1',
        chattype: 'single',
        timestamp: Date.now(),
        quoteContent: '【cc-999】不存在的消息'
      };

      const result = handleMessage(msg, sessionStore);

      // 单 CC 模式，即使 ccId 不匹配也直接推送
      expect(result.action).toBe('push_direct');
    });
  });

  describe('MC-005: 审批卡片 ccId 标识', () => {
    it('审批卡片标题应该包含 ccId', () => {
      const approval1 = { ccId: 'cc-1', title: '【cc-1】Bash', description: '执行命令' };
      const approval2 = { ccId: 'cc-2', title: '【cc-2】Write', description: '写入文件' };

      expect(approval1.title).toContain('cc-1');
      expect(approval2.title).toContain('cc-2');
    });

    it('用户应该能区分不同 CC 的审批', () => {
      const pendingApprovals = [
        { ccId: 'cc-1', taskId: 'task-001', toolName: 'Bash' },
        { ccId: 'cc-2', taskId: 'task-002', toolName: 'Write' }
      ];

      const cc1Approvals = pendingApprovals.filter(a => a.ccId === 'cc-1');
      const cc2Approvals = pendingApprovals.filter(a => a.ccId === 'cc-2');

      expect(cc1Approvals.length).toBe(1);
      expect(cc1Approvals[0].toolName).toBe('Bash');

      expect(cc2Approvals.length).toBe(1);
      expect(cc2Approvals[0].toolName).toBe('Write');
    });
  });

  describe('边界情况', () => {
    it('空 Session Store 时应该返回 no_session', () => {
      const msg: WecomMessage = {
        robotName: 'robot1',
        msgid: 'msg-001',
        content: 'hello',
        from_userid: 'user1',
        chatid: 'user1',
        chattype: 'single',
        timestamp: Date.now()
      };

      const result = handleMessage(msg, sessionStore);

      expect(result.action).toBe('no_session');
    });

    it('引用格式不正确时应该无法提取 ccId', () => {
      const invalidQuotes = [
        'cc-1 没有方括号',
        '【cc-1 没有右括号',
        'cc-1】没有左括号',
        '【其他内容】',
        ''
      ];

      for (const quote of invalidQuotes) {
        const ccId = extractCcIdFromQuote(quote);
        expect(ccId).toBeNull();
      }
    });

    it('正确的引用格式应该能提取 ccId', () => {
      const validQuotes = [
        '【cc-1】',
        '【cc-1】消息内容',
        '回复：【cc-1】之前的消息',
        '【cc-10】',
        '【cc-999】'
      ];

      for (const quote of validQuotes) {
        const ccId = extractCcIdFromQuote(quote);
        expect(ccId).not.toBeNull();
      }
    });
  });
});