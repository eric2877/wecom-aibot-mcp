/**
 * 保活监控模块
 *
 * 定期检查待处理审批，发送审批提醒（同时也是 WebSocket 保活消息）
 *
 * v2.0 架构变更：
 * - 使用 Session 获取 robotName
 * - 不再使用 projectDir
 */

import { getClient, getConnectionState } from './connection-manager.js';

const KEEPALIVE_INTERVAL_MINUTES = 5;  // 每 5 分钟
const CHECK_INTERVAL_MS = 60000;       // 每分钟检查一次

let monitorTimer: NodeJS.Timeout | null = null;

/**
 * 启动保活监控
 */
export function startKeepaliveMonitor(): void {
  monitorTimer = setInterval(checkAndSendKeepalive, CHECK_INTERVAL_MS);
  console.log('[keepalive] 保活监控已启动 (每 5 分钟发送审批提醒)');
}

/**
 * 停止保活监控
 */
export function stopKeepaliveMonitor(): void {
  if (monitorTimer) {
    clearInterval(monitorTimer);
    monitorTimer = null;
  }
  console.log('[keepalive] 保活监控已停止');
}

/**
 * 检查并发送保活消息
 */
async function checkAndSendKeepalive(): Promise<void> {
  // 检查是否有连接
  const state = getConnectionState();
  if (!state.connected || !state.robotName) {
    return;
  }

  // 获取客户端（会自动重连）
  const client = await getClient(state.robotName);
  if (!client) {
    return;
  }

  // 获取待处理审批
  const pendingApprovals = client.getPendingApprovalsRecords();

  if (pendingApprovals.length === 0) {
    return;
  }

  const now = Date.now();

  for (const approval of pendingApprovals) {
    const waitTime = now - approval.timestamp;
    const minutes = Math.floor(waitTime / 60000);

    // 每 5 分钟发送保活消息
    if (minutes > 0 &&
        minutes % KEEPALIVE_INTERVAL_MINUTES === 0 &&
        approval.lastKeepaliveMinute !== minutes) {

      await sendKeepaliveMessage(approval, minutes, state.robotName);
      approval.lastKeepaliveMinute = minutes;
      approval.keepaliveCount = (approval.keepaliveCount || 0) + 1;
    }
  }
}

/**
 * 发送保活消息（同时也是审批提醒）
 */
async function sendKeepaliveMessage(approval: any, minutes: number, robotName: string): Promise<void> {
  const toolName = approval.toolName || '未知操作';

  const message = `【审批提醒】您有 ${minutes} 分钟前的审批请求待处理（${toolName}），请尽快在企业微信中审批。`;

  try {
    const client = await getClient(robotName);
    if (client) {
      const sent = await client.sendText(message);
      if (sent) {
        console.log(`[keepalive] 已发送审批提醒: ${approval.taskId}, 等待 ${minutes} 分钟`);
      }
    }
  } catch (err) {
    console.error(`[keepalive] 发送审批提醒失败:`, err);
  }
}

/**
 * 手动触发保活检查（用于测试）
 */
export async function triggerKeepaliveCheck(): Promise<void> {
  await checkAndSendKeepalive();
}