/**
 * 消息工具
 * - send_message
 * - get_pending_messages
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getClient } from '../connection-manager.js';
import { getCcIdBinding, touchCcId, isCcIdRegistered } from '../cc-registry.js';
import { subscribeWecomMessageByRobot, WecomMessage } from '../message-bus.js';

export function registerMessagingTools(server: McpServer): void {
  // ────────────────────────────────────────────
  // send_message
  // ────────────────────────────────────────────
  server.tool(
    'send_message',
    '向企业微信发送消息（用于通知用户）。自动添加【ccId】前缀。群聊时传 targetUser=chatid 可回复群里。',
    {
      ccId: z.string().describe('CC 身份标识'),
      content: z.string().describe('消息内容（支持 Markdown）'),
      targetUser: z.string().optional().describe('目标用户/群 ID（可选，默认推送到默认用户）'),
    },
    async ({ ccId, content, targetUser }) => {
      const binding = getCcIdBinding(ccId);
      if (!binding) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ success: false, error: '请先调用 enter_headless_mode' })
          }]
        };
      }

      const client = await getClient(binding.robotName);
      if (!client) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ success: false, error: '机器人未连接' })
          }]
        };
      }

      const prefixedContent = `【${ccId}】${content}`;
      const ok = await client.sendText(prefixedContent, targetUser);
      touchCcId(ccId);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ success: ok, message: ok ? '发送成功' : '发送失败' })
        }]
      };
    }
  );

  // ────────────────────────────────────────────
  // get_pending_messages（长轮询）
  // ────────────────────────────────────────────
  server.tool(
    'get_pending_messages',
    '长轮询获取待处理消息。有消息立即返回，无消息等待 timeout_ms 后返回 timeout:true。timeout 后立即重新调用，不需要 sleep。heartbeat 中的 approvalPending 标记有待处理审批时，请先完成审批再继续。',
    {
      ccId: z.string().describe('CC 身份标识'),
      timeout_ms: z.number().optional().describe('超时时间（毫秒，默认 300000 即 5 分钟）'),
      clear: z.boolean().optional().describe('是否清除已获取消息（默认 true）'),
    },
    async ({ ccId, timeout_ms = 300000, clear = true }) => {
      if (!isCcIdRegistered(ccId)) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ error: '请先调用 enter_headless_mode' })
          }]
        };
      }

      const binding = getCcIdBinding(ccId);
      if (!binding) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ error: '请先调用 enter_headless_mode' })
          }]
        };
      }

      const { robotName } = binding;
      const client = await getClient(robotName);

      if (!client) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ error: '机器人未连接' })
          }]
        };
      }

      // 检查有待处理审批（用户在企业微信界面点击后 resolved 会被标记，不再出现在此列表）
      const pendingApprovals = client.getPendingApprovalsRecords().map(a => ({
        toolName: a.toolName || '未知操作',
        waitMinutes: Math.floor((Date.now() - a.timestamp) / 60000),
      }));

      // 先检查是否有已缓存的消息
      const cached = client.getPendingMessages(clear);
      if (cached.length > 0) {
        touchCcId(ccId);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              count: cached.length,
              messages: cached.map(m => ({
                content: m.content,
                from: m.from_userid,
                chatid: m.chatid,
                chattype: m.chattype,
                time: new Date(m.timestamp).toISOString(),
                quoteContent: m.quoteContent,
              })),
              heartbeat: { ccId, robotName, pollTimeout: timeout_ms, approvalPending: pendingApprovals.length > 0, approvals: pendingApprovals },
            })
          }]
        };
      }

      // 无缓存消息，订阅 message-bus 长轮询
      const result = await new Promise<{ messages: WecomMessage[]; timeout: boolean }>((resolve) => {
        let settled = false;
        const collected: WecomMessage[] = [];

        const timer = setTimeout(() => {
          if (!settled) {
            settled = true;
            sub.unsubscribe();
            resolve({ messages: collected, timeout: true });
          }
        }, timeout_ms);

        const sub = subscribeWecomMessageByRobot(robotName, (msg: WecomMessage) => {
          collected.push(msg);
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            sub.unsubscribe();

            // 如果 clear=true，消费掉 client 缓存中对应消息
            if (clear) client.getPendingMessages(true);

            resolve({ messages: collected, timeout: false });
          }
        });
      });

      touchCcId(ccId);

      // 返回前再次检查审批状态（长轮询期间用户可能已审批）
      const postPollApprovals = client.getPendingApprovalsRecords().map(a => ({
        toolName: a.toolName || '未知操作',
        waitMinutes: Math.floor((Date.now() - a.timestamp) / 60000),
      }));

      if (result.timeout) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              count: 0,
              messages: [],
              timeout: true,
              heartbeat: { ccId, robotName, pollTimeout: timeout_ms, approvalPending: postPollApprovals.length > 0, approvals: postPollApprovals },
            })
          }]
        };
      }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            count: result.messages.length,
            messages: result.messages.map(m => ({
              content: m.content,
              from: m.from_userid,
              chatid: m.chatid,
              chattype: m.chattype,
              time: new Date(m.timestamp).toISOString(),
              quoteContent: m.quoteContent,
            })),
            heartbeat: { ccId, robotName, pollTimeout: timeout_ms, approvalPending: postPollApprovals.length > 0, approvals: postPollApprovals },
          })
        }]
      };
    }
  );
}
