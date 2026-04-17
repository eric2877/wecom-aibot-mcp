/**
 * 消息总线模块
 *
 * 使用 RxJS 实现消息的发布-订阅模式：
 * - WecomClient 收到微信消息 → 发布到 bus
 * - MCP Server 订阅消息 → SSE 推送给 CC
 * - 按 CCID 过滤消息（基于引用内容）
 *
 * v2.1 使用订阅计数替代 tap 计数：
 * - subscribe 时计数 +1
 * - unsubscribe 时计数 -1（自动处理掉线）
 * - 订阅数 = 1 时直接发给唯一订阅者
 * - 订阅数 > 1 时检查 ccId
 */

import { Subject } from 'rxjs';
import { filter, finalize } from 'rxjs/operators';

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
// 审批事件结构
// ============================================

export interface ApprovalEvent {
  robotName: string;      // 机器人名称
  taskId: string;         // 审批任务 ID
  result: 'allow-once' | 'allow-always' | 'deny';  // 审批结果
  ccId?: string;          // 关联的 ccId（用于 SSE 推送）
  timestamp: number;      // 事件时间
}

// ============================================
// 订阅计数器（替代 tap 计数）
// ============================================
const subscriberCount = new Map<string, number>();  // robotName → 订阅数

export function getSubscriberCount(robotName: string): number {
  return subscriberCount.get(robotName) || 0;
}

function incrementSubscriberCount(robotName: string): void {
  const current = subscriberCount.get(robotName) || 0;
  subscriberCount.set(robotName, current + 1);
}

function decrementSubscriberCount(robotName: string): void {
  const current = subscriberCount.get(robotName) || 0;
  if (current > 0) {
    subscriberCount.set(robotName, current - 1);
  }
}

// ============================================
// 消息总线（RxJS Subject）
// ============================================

const wecomMessage$ = new Subject<WecomMessage>();
const approvalEvent$ = new Subject<ApprovalEvent>();

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
 * 发布审批事件（由 WecomClient 调用）
 */
export function publishApprovalEvent(event: ApprovalEvent): void {
  approvalEvent$.next(event);
}

/**
 * 订阅所有微信消息
 */
export function subscribeWecomMessage(callback: (msg: WecomMessage) => void) {
  return wecomMessage$.subscribe(callback);
}

/**
 * 订阅所有审批事件
 */
export function subscribeApprovalEvent(callback: (event: ApprovalEvent) => void) {
  return approvalEvent$.subscribe(callback);
}

/**
 * 订阅特定机器人的微信消息（带订阅计数）
 */
export function subscribeWecomMessageByRobot(
  robotName: string,
  callback: (msg: WecomMessage) => void
) {
  incrementSubscriberCount(robotName);

  return wecomMessage$.pipe(
    filter(msg => msg.robotName === robotName),
    finalize(() => decrementSubscriberCount(robotName))  // 无论何时结束都减计数
  ).subscribe(callback);
}

/**
 * 订阅特定机器人且匹配 ccId 的消息
 * 用于多 CC 共用一个机器人场景的过滤
 */
export function subscribeWecomMessageByCcId(
  robotName: string,
  ccId: string,
  callback: (msg: WecomMessage) => void
) {
  incrementSubscriberCount(robotName);

  return wecomMessage$.pipe(
    filter(msg => msg.robotName === robotName),
    filter(msg => isMessageForCcId(msg, ccId)),
    finalize(() => decrementSubscriberCount(robotName))  // 无论何时结束都减计数
  ).subscribe(callback);
}

/**
 * 检查消息是否属于指定的 ccId
 */
function isMessageForCcId(msg: WecomMessage, ccId: string): boolean {
  // 有引用内容，检查是否引用该 ccId
  if (msg.quoteContent) {
    const match = msg.quoteContent.match(/【([^】]+)】/);
    if (match && match[1] === ccId) {
      return true;  // 引用了该 ccId，消息属于该 CC
    }
    // 引用了其他 ccId，不属于当前 ccId
    if (match) {
      return false;
    }
  }
  // 无引用内容，消息不属于任何特定 CC
  // 在多 CC 场景下，需要用户指定
  return false;
}

// 导出 Observable（供高级用法）
export { wecomMessage$ };