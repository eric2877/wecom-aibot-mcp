/**
 * 消息总线模块
 *
 * 使用 RxJS 实现消息的发布-订阅模式：
 * - WecomClient 收到微信消息 → 发布到 bus
 * - MCP Server 订阅消息 → SSE 推送给 CC
 * - 按 CCID 过滤消息（基于引用内容）
 */

import { Subject } from 'rxjs';
import { filter } from 'rxjs/operators';

// ============================================
// 微信消息结构
// ============================================

export interface WecomMessage {
  robotName: string;      // 机器人名称
  msgid: string;
  content: string;
  from_userid: string;
  chatid: string;
  chattype: 'single' | 'group';
  timestamp: number;
  quoteContent?: string;  // 引用内容（用于 CCID 过滤）
}

// ============================================
// 消息总线（RxJS Subject）
// ============================================

const wecomMessage$ = new Subject<WecomMessage>();

// ============================================
// 发布/订阅接口
// ============================================

/**
 * 发布微信消息（由 WecomClient 调用）
 */
export function publishWecomMessage(msg: WecomMessage): void {
  wecomMessage$.next(msg);
}

/**
 * 订阅所有微信消息
 */
export function subscribeWecomMessage(callback: (msg: WecomMessage) => void) {
  return wecomMessage$.subscribe(callback);
}

/**
 * 订阅特定机器人的微信消息
 */
export function subscribeWecomMessageByRobot(
  robotName: string,
  callback: (msg: WecomMessage) => void
) {
  return wecomMessage$.pipe(
    filter(msg => msg.robotName === robotName)
  ).subscribe(callback);
}

// 导出 Observable（供高级用法）
export { wecomMessage$ };