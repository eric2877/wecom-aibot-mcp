/**
 * 消息总线单元测试
 *
 * 测试覆盖：
 * - MB-001: 发布消息
 * - MB-002: 订阅所有消息
 * - MB-003: 按机器人过滤
 * - MB-004: 多订阅者
 * - MB-005: 取消订阅
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  publishWecomMessage,
  subscribeWecomMessage,
  subscribeWecomMessageByRobot,
  WecomMessage,
  wecomMessage$
} from '../../src/message-bus';

describe('MessageBus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('MB-001: 发布消息', () => {
    it('应该能发布消息到总线', () => {
      const callback = vi.fn();
      subscribeWecomMessage(callback);

      const msg: WecomMessage = {
        robotName: 'test-robot',
        msgid: 'msg-001',
        content: 'hello',
        from_userid: 'user1',
        chatid: 'chat1',
        chattype: 'single',
        timestamp: Date.now()
      };

      publishWecomMessage(msg);

      expect(callback).toHaveBeenCalledWith(msg);
      expect(callback).toHaveBeenCalledTimes(1);
    });

    it('发布多条消息应该被所有订阅者接收', () => {
      const callback = vi.fn();
      subscribeWecomMessage(callback);

      for (let i = 0; i < 5; i++) {
        publishWecomMessage({
          robotName: `robot${i}`,
          msgid: `msg-${i}`,
          content: `message ${i}`,
          from_userid: 'user1',
          chatid: 'chat1',
          chattype: 'single',
          timestamp: Date.now()
        });
      }

      expect(callback).toHaveBeenCalledTimes(5);
    });
  });

  describe('MB-002: 订阅所有消息', () => {
    it('应该能订阅所有消息', () => {
      const callback = vi.fn();
      const subscription = subscribeWecomMessage(callback);

      publishWecomMessage({
        robotName: 'test',
        msgid: '001',
        content: 'hello',
        from_userid: 'user1',
        chatid: 'chat1',
        chattype: 'single',
        timestamp: Date.now()
      });

      expect(callback).toHaveBeenCalled();
      expect(subscription).toBeDefined();
    });
  });

  describe('MB-003: 按机器人过滤', () => {
    it('应该能按 robotName 过滤消息', () => {
      const callback1 = vi.fn();
      const callback2 = vi.fn();

      subscribeWecomMessageByRobot('robot1', callback1);
      subscribeWecomMessageByRobot('robot2', callback2);

      publishWecomMessage({
        robotName: 'robot1',
        msgid: '001',
        content: 'msg1',
        from_userid: 'u1',
        chatid: 'c1',
        chattype: 'single',
        timestamp: 1
      });

      publishWecomMessage({
        robotName: 'robot2',
        msgid: '002',
        content: 'msg2',
        from_userid: 'u1',
        chatid: 'c1',
        chattype: 'single',
        timestamp: 2
      });

      publishWecomMessage({
        robotName: 'robot1',
        msgid: '003',
        content: 'msg3',
        from_userid: 'u1',
        chatid: 'c1',
        chattype: 'single',
        timestamp: 3
      });

      expect(callback1).toHaveBeenCalledTimes(2);
      expect(callback2).toHaveBeenCalledTimes(1);
    });

    it('非匹配机器人消息不应该触发回调', () => {
      const callback = vi.fn();
      subscribeWecomMessageByRobot('robot1', callback);

      publishWecomMessage({
        robotName: 'robot2',
        msgid: '001',
        content: 'msg1',
        from_userid: 'u1',
        chatid: 'c1',
        chattype: 'single',
        timestamp: 1
      });

      expect(callback).not.toHaveBeenCalled();
    });
  });

  describe('MB-004: 多订阅者', () => {
    it('应该能支持多个订阅者同时接收消息', () => {
      const callbacks = [vi.fn(), vi.fn(), vi.fn()];

      callbacks.forEach(cb => subscribeWecomMessage(cb));

      const msg: WecomMessage = {
        robotName: 'test',
        msgid: '001',
        content: 'hello',
        from_userid: 'user1',
        chatid: 'chat1',
        chattype: 'single',
        timestamp: Date.now()
      };

      publishWecomMessage(msg);

      callbacks.forEach(cb => {
        expect(cb).toHaveBeenCalledWith(msg);
        expect(cb).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('MB-005: 取消订阅', () => {
    it('应该能取消订阅并停止接收消息', () => {
      const callback = vi.fn();
      const subscription = subscribeWecomMessage(callback);

      publishWecomMessage({
        robotName: 'test',
        msgid: '001',
        content: 'msg1',
        from_userid: 'u1',
        chatid: 'c1',
        chattype: 'single',
        timestamp: 1
      });

      expect(callback).toHaveBeenCalledTimes(1);

      // 取消订阅
      subscription.unsubscribe();

      publishWecomMessage({
        robotName: 'test',
        msgid: '002',
        content: 'msg2',
        from_userid: 'u1',
        chatid: 'c1',
        chattype: 'single',
        timestamp: 2
      });

      // 取消订阅后不再收到消息
      expect(callback).toHaveBeenCalledTimes(1);
    });
  });

  describe('消息结构', () => {
    it('消息应该包含所有必需字段', () => {
      const msg: WecomMessage = {
        robotName: 'test-robot',
        msgid: 'msg-001',
        content: 'test content',
        from_userid: 'user1',
        chatid: 'chat1',
        chattype: 'single',
        timestamp: 1234567890
      };

      expect(msg.robotName).toBe('test-robot');
      expect(msg.msgid).toBe('msg-001');
      expect(msg.content).toBe('test content');
      expect(msg.from_userid).toBe('user1');
      expect(msg.chatid).toBe('chat1');
      expect(msg.chattype).toBe('single');
      expect(msg.timestamp).toBe(1234567890);
    });

    it('quoteContent 应该是可选的', () => {
      const msgWithQuote: WecomMessage = {
        robotName: 'test-robot',
        msgid: 'msg-001',
        content: 'test content',
        from_userid: 'user1',
        chatid: 'chat1',
        chattype: 'single',
        timestamp: 1234567890,
        quoteContent: '【cc-1】引用内容'
      };

      const msgWithoutQuote: WecomMessage = {
        robotName: 'test-robot',
        msgid: 'msg-002',
        content: 'test content',
        from_userid: 'user1',
        chatid: 'chat1',
        chattype: 'single',
        timestamp: 1234567890
      };

      expect(msgWithQuote.quoteContent).toBe('【cc-1】引用内容');
      expect(msgWithoutQuote.quoteContent).toBeUndefined();
    });

    it('chattype 应该支持 single 和 group', () => {
      const singleMsg: WecomMessage = {
        robotName: 'test',
        msgid: '001',
        content: '',
        from_userid: 'user1',
        chatid: 'user1',
        chattype: 'single',
        timestamp: 0
      };

      const groupMsg: WecomMessage = {
        robotName: 'test',
        msgid: '002',
        content: '',
        from_userid: 'user1',
        chatid: 'group123',
        chattype: 'group',
        timestamp: 0
      };

      expect(singleMsg.chattype).toBe('single');
      expect(groupMsg.chattype).toBe('group');
    });
  });

  describe('引用路由场景', () => {
    it('应该能从引用内容中提取 ccId', () => {
      const msg: WecomMessage = {
        robotName: 'test',
        msgid: '001',
        content: 'reply',
        from_userid: 'user1',
        chatid: 'chat1',
        chattype: 'single',
        timestamp: Date.now(),
        quoteContent: '【cc-1】original message'
      };

      const match = msg.quoteContent?.match(/【(cc-\d+)】/);
      const ccId = match ? match[1] : null;

      expect(ccId).toBe('cc-1');
    });

    it('无引用内容时 ccId 应该为 null', () => {
      const msg: WecomMessage = {
        robotName: 'test',
        msgid: '001',
        content: 'message',
        from_userid: 'user1',
        chatid: 'chat1',
        chattype: 'single',
        timestamp: Date.now()
      };

      const match = msg.quoteContent?.match(/【(cc-\d+)】/);
      const ccId = match ? match[1] : null;

      expect(ccId).toBeNull();
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
        const match = quote.match(/【(cc-\d+)】/);
        const ccId = match ? match[1] : null;
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
        const match = quote.match(/【(cc-\d+)】/);
        expect(match).not.toBeNull();
      }
    });
  });

  describe('wecomMessage$ Observable', () => {
    it('应该能直接使用 Observable', () => {
      const callback = vi.fn();
      wecomMessage$.subscribe(callback);

      publishWecomMessage({
        robotName: 'test',
        msgid: '001',
        content: 'hello',
        from_userid: 'user1',
        chatid: 'chat1',
        chattype: 'single',
        timestamp: Date.now()
      });

      expect(callback).toHaveBeenCalled();
    });
  });
});