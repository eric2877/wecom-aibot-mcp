/**
 * WebSocket 客户端管理模块
 *
 * 使用 @wecom/aibot-node-sdk 维护长连接，
 * 管理消息队列和审批状态。
 */
import AiBot from '@wecom/aibot-node-sdk';
import type { WsFrame } from '@wecom/aibot-node-sdk';
import { generateReqId } from '@wecom/aibot-node-sdk';

// 审批结果存储
interface ApprovalRecord {
  taskId: string;
  resolved: boolean;
  result?: 'allow-once' | 'allow-always' | 'deny';
  timestamp: number;
  toolName?: string;  // 审批的工具名称
}

// 消息队列（用于等待用户回复）
interface MessageRecord {
  msgid: string;
  content: string;
  timestamp: number;
  from_userid: string;
}

class WecomClient {
  private wsClient: AiBot.WSClient;
  private approvals: Map<string, ApprovalRecord> = new Map();
  private messages: MessageRecord[] = [];
  private connected = false;
  private targetUserId: string;

  constructor(botId: string, secret: string, targetUserId: string) {
    this.targetUserId = targetUserId;
    this.wsClient = new AiBot.WSClient({
      botId,
      secret,
      heartbeatInterval: 30000,
      maxReconnectAttempts: -1, // 无限重连
    });

    this.setupEventHandlers();
  }

  private setupEventHandlers() {
    this.wsClient.on('connected', () => {
      console.log('[wecom] WebSocket 连接已建立');
    });

    this.wsClient.on('authenticated', () => {
      this.connected = true;
      console.log('[wecom] 认证成功，长连接已就绪');
    });

    this.wsClient.on('disconnected', (reason: string) => {
      this.connected = false;
      console.log(`[wecom] 连接断开: ${reason}`);
    });

    this.wsClient.on('reconnecting', (attempt: number) => {
      console.log(`[wecom] 正在重连 (第 ${attempt} 次)`);
    });

    this.wsClient.on('error', (err: Error) => {
      console.error(`[wecom] 错误: ${err.message}`);
    });

    // 监听所有消息（存储到队列）
    this.wsClient.on('message', (frame: WsFrame) => {
      this.handleMessage(frame);
    });

    // 监听模板卡片事件（审批结果）
    this.wsClient.on('event.template_card_event', (frame: WsFrame) => {
      this.handleApprovalResponse(frame);
    });

    // 监听进入会话事件
    this.wsClient.on('event.enter_chat', (frame: WsFrame) => {
      console.log('[wecom] 用户进入会话');
      this.wsClient.replyWelcome(frame, {
        msgtype: 'text',
        text: { content: '您好！Claude Code 审批通道已就绪。' },
      });
    });
  }

  private handleMessage(frame: WsFrame) {
    const body = frame.body;
    if (!body) return;

    const msgid = body.msgid;
    const from_userid = body.from?.userid || '';
    const msgtype = body.msgtype;

    let content = '';
    if (msgtype === 'text') {
      content = body.text?.content || '';
    } else if (msgtype === 'mixed') {
      content = (body.mixed?.items || [])
        .filter((i: any) => i.type === 'text')
        .map((i: any) => i.text?.content || '')
        .join('');
    }

    if (content) {
      this.messages.push({
        msgid,
        content,
        timestamp: Date.now(),
        from_userid,
      });
      console.log(`[wecom] 收到消息: ${from_userid} -> ${content.slice(0, 100)}`);
    }
  }

  private handleApprovalResponse(frame: WsFrame) {
    const event = frame.body?.event;
    if (!event) return;

    // template_card_event 结构在 event.template_card_event 中
    const cardEvent = event.template_card_event;
    if (!cardEvent) return;

    const taskId = cardEvent.task_id;
    const eventKey = cardEvent.event_key; // 用户点击的按钮 key

    console.log(`[wecom] 收到审批响应: taskId=${taskId}, key=${eventKey}`);

    const approval = this.approvals.get(taskId);
    if (approval && !approval.resolved) {
      approval.resolved = true;
      approval.result = eventKey as 'allow-once' | 'allow-always' | 'deny';
      approval.timestamp = Date.now();

      // 发送确认消息给用户
      const resultText = eventKey === 'allow-once' ? '✅ 已允许（本次）'
        : eventKey === 'allow-always' ? '✅ 已允许（永久）'
        : '❌ 已拒绝';
      const toolInfo = approval.toolName ? `: ${approval.toolName}` : '';

      this.sendText(`**审批结果**${toolInfo}\n\n${resultText}`).catch(err => {
        console.error('[wecom] 发送审批确认失败:', err);
      });
    }
  }

  // 连接
  connect() {
    this.wsClient.connect();
  }

  // 断开
  disconnect() {
    this.wsClient.disconnect();
  }

  // 检查连接状态
  isConnected() {
    return this.connected;
  }

  // 获取默认目标用户
  getDefaultTargetUser(): string {
    return this.targetUserId;
  }

  // 发送文本消息（主动推送）
  async sendText(content: string, targetUser?: string): Promise<boolean> {
    const userId = targetUser || this.targetUserId;
    if (!this.connected) {
      console.error('[wecom] 未连接，无法发送消息');
      return false;
    }

    try {
      await this.wsClient.sendMessage(userId, {
        msgtype: 'markdown',
        markdown: { content },
      });
      console.log(`[wecom] 已发送消息到 ${userId}`);
      return true;
    } catch (err) {
      console.error(`[wecom] 发送失败: ${err}`);
      return false;
    }
  }

  // 发送审批请求（带按钮的模板卡片）
  async sendApprovalRequest(
    title: string,
    description: string,
    requestId: string,
    targetUser?: string
  ): Promise<string> {
    const userId = targetUser || this.targetUserId;
    const taskId = `approval_${requestId}_${Date.now()}`;

    if (!this.connected) {
      throw new Error('WebSocket 未连接');
    }

    // 从 title 中提取工具名称（格式: 【待审批】Bash）
    const toolName = title.replace('【待审批】', '');

    // 存储审批记录
    this.approvals.set(taskId, {
      taskId,
      resolved: false,
      timestamp: Date.now(),
      toolName,
    });

    // 发送模板卡片
    await this.wsClient.sendMessage(userId, {
      msgtype: 'template_card',
      template_card: {
        card_type: 'button_interaction',
        main_title: { title },
        sub_title_text: description,
        button_list: [
          { text: '允许一次', key: 'allow-once', style: 1 },
          { text: '永久允许', key: 'allow-always', style: 1 },
          { text: '拒绝', key: 'deny', style: 2 },
        ],
        task_id: taskId,
      },
    });

    console.log(`[wecom] 已发送审批请求到 ${userId}: ${taskId}`);
    return taskId;
  }

  // 获取审批结果（非阻塞，立即返回当前状态）
  getApprovalResult(taskId: string): 'pending' | 'allow-once' | 'allow-always' | 'deny' {
    const approval = this.approvals.get(taskId);
    if (!approval) {
      return 'pending';
    }
    if (approval.resolved) {
      return approval.result!;
    }
    return 'pending';
  }

  // 获取所有待处理的审批任务 ID（供 hook 轮询使用）
  getPendingApprovals(): string[] {
    return Array.from(this.approvals.entries())
      .filter(([_, a]) => !a.resolved)
      .map(([taskId, _]) => taskId);
  }

  // 获取最新消息（用于等待回复）
  getLatestMessage(afterTimestamp: number): MessageRecord | undefined {
    return this.messages.find(m => m.timestamp > afterTimestamp && m.from_userid === this.targetUserId);
  }

  // 获取所有待处理消息（非阻塞）
  getPendingMessages(clear: boolean = true): MessageRecord[] {
    const result = [...this.messages];
    if (clear) {
      this.messages = [];
    }
    return result;
  }

  // 清理过期消息
  cleanupMessages(maxAgeMs = 300000) {
    const cutoff = Date.now() - maxAgeMs;
    this.messages = this.messages.filter(m => m.timestamp > cutoff);
    this.approvals.forEach((a, k) => {
      if (a.timestamp < cutoff) this.approvals.delete(k);
    });
  }
}

// 单例实例
let instance: WecomClient | null = null;

export function initClient(botId: string, secret: string, targetUserId: string): WecomClient {
  if (instance) {
    instance.disconnect();
  }
  instance = new WecomClient(botId, secret, targetUserId);
  instance.connect();
  return instance;
}

export function getClient(): WecomClient {
  if (!instance) {
    throw new Error('WecomClient 未初始化，请先调用 initClient');
  }
  return instance;
}

export { WecomClient, ApprovalRecord, MessageRecord };