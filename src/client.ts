/**
 * WebSocket 客户端管理模块
 *
 * 使用 @wecom/aibot-node-sdk 维护长连接，
 * 管理消息队列和审批状态。
 *
 * v3.0 新增：
 * - 审批去重机制（相同操作复用已有审批）
 * - 消息序号机制（保证消息顺序）
 * - 审批过期时间
 */
import AiBot from '@wecom/aibot-node-sdk';
import type { WsFrame } from '@wecom/aibot-node-sdk';
import { EventEmitter } from 'events';
import {
  logConnected,
  logAuthenticated,
  logDisconnected,
  logReconnecting,
  logError,
} from './connection-log.js';
import { publishWecomMessage } from './message-bus.js';
import { hashOperation } from './utils/hash.js';
import { logger } from './logger.js';

// 最大待处理消息数量
const MAX_PENDING_MESSAGES = 100;

// 全局消息序号计数器
let globalMessageSeq = 0;

// 审批结果存储
interface ApprovalRecord {
  taskId: string;
  resolved: boolean;
  result?: 'allow-once' | 'allow-always' | 'deny';
  timestamp: number;
  toolName?: string;  // 审批的工具名称
  toolInput?: Record<string, unknown>;  // 工具输入（用于智能代批）
  projectDir?: string;  // 项目目录（用于智能代批）
  description?: string;  // 审批请求原文描述
  lastKeepaliveMinute?: number;  // 最后发送保活的分钟数
  keepaliveCount?: number;       // 已发送保活次数
  // 审批去重字段
  operationHash?: string;  // 操作哈希（用于去重）
  consumed?: boolean;      // 是否已消费（allow-once 只能消费一次）
}

// 消息队列（用于等待用户回复）
interface MessageRecord {
  seq: number;           // 消息序号（服务端生成）
  msgid: string;
  content: string;
  timestamp: number;
  serverTime: number;    // 服务端接收时间
  from_userid: string;
  chatid: string;      // 单聊=userid，群聊=群ID
  chattype: 'single' | 'group';  // 会话类型
  quoteContent?: string;  // 引用内容（用于多 CC 路由）
}

// 待发送消息队列（断线期间缓存）
interface PendingMessage {
  type: 'text' | 'approval';
  content: any;
  targetUser?: string;
  timestamp: number;
}

class WecomClient extends EventEmitter {
  private wsClient: AiBot.WSClient;
  private approvals: Map<string, ApprovalRecord> = new Map();
  private messages: MessageRecord[] = [];
  private pendingMessages: PendingMessage[] = [];  // 待发送消息队列
  private connected = false;
  private targetUserId: string;
  private botId: string;  // 保存 botId 用于生成授权 URL
  private robotName: string;  // 机器人名称（用于消息总线路由）
  private wasReconnecting = false;  // 跟踪是否处于重连状态
  private reconnectAttempt = 0;  // 重连尝试次数
  private lastDisconnectTime = 0;  // 最后断线时间
  private disconnectNotifyCount = 0;  // 断线通知次数（最多1次）

  constructor(botId: string, secret: string, targetUserId: string, robotName: string) {
    super();
    this.botId = botId;
    this.targetUserId = targetUserId;
    this.robotName = robotName;
    this.wsClient = new AiBot.WSClient({
      botId,
      secret,
      heartbeatInterval: 15000,  // 15 秒心跳，更快检测断线
      maxReconnectAttempts: -1,  // 无限重连
    });

    this.setupEventHandlers();

    // 定期清理过期的消息和审批记录（每分钟清理一次，超过 5 分钟的记录会被删除）
    setInterval(() => {
      this.cleanupMessages();
    }, 60000);
  }

  
  // 生成授权页面 URL
  getAuthUrl(): string {
    return `https://work.weixin.qq.com/ai/aiHelper/authorizationPage?str_aibotid=${this.botId}&type=6&from=chat&forceInnerBrowser=1`;
  }

  private setupEventHandlers() {
    this.wsClient.on('connected', () => {
      logConnected();
    });

    this.wsClient.on('authenticated', () => {
      const wasReconnecting = this.wasReconnecting;
      this.connected = true;
      this.wasReconnecting = false;
      this.reconnectAttempt = 0;
      this.disconnectNotifyCount = 0;  // 重连成功后重置断线通知计数
      logAuthenticated();

      // 重连成功后发送通知
      if (wasReconnecting) {
        this.sendText('【系统】连接已恢复').catch(err => {
          logger.error('wecom', `发送恢复通知失败: ${err}`);
        });
        // 刷新待发送消息队列
        this.flushPendingMessages();
      }
    });

    this.wsClient.on('disconnected', (reason: string) => {
      this.connected = false;
      this.wasReconnecting = true;
      this.lastDisconnectTime = Date.now();
      logDisconnected(reason);

      // 断线通知最多发1次
      if (this.disconnectNotifyCount < 1) {
        this.disconnectNotifyCount++;
        this.sendText('【系统】连接中断，正在重连...').catch(err => {
          logger.error('wecom', `发送断线通知失败: ${err}`);
        });
      }
    });

    this.wsClient.on('reconnecting', (attempt: number) => {
      this.reconnectAttempt = attempt;
      logReconnecting(attempt);
    });

    this.wsClient.on('error', (err: Error) => {
      logError(err.message);

      // 检测授权相关错误（40058: invalid Request Parameter）
      if (err.message.includes('40058') || err.message.includes('invalid Request Parameter')) {
        logger.info('wecom', '');
        logger.info('wecom', '  ⚠️  机器人未授权或配置有误，请检查以下事项：');
        logger.info('wecom', '');
        logger.info('wecom', '  1. 新建机器人需要等待约 2 分钟同步时间，请稍后再试');
        logger.info('wecom', '  2. 确认 Bot ID 和 Secret 是否正确');
        logger.info('wecom', '  3. 完成机器人授权（任选其一）：');
        logger.info('wecom', '     • 在电脑端企业微信APP中打开：机器人详情 → 可使用权限 → 授权');
        logger.info('wecom', '     • 打开浏览器访问以下地址，使用手机企业微信扫码授权：');
        logger.info('wecom', `       ${this.getAuthUrl()}`);
        logger.info('wecom', '');
      }
    });

    // 监听所有消息（存储到队列）
    this.wsClient.on('message', (frame: WsFrame) => {
      this.handleMessage(frame);
    });

    // 监听模板卡片事件（审批结果）
    this.wsClient.on('event.template_card_event', (frame: WsFrame) => {
      logger.log('wecom', `收到 template_card_event 事件: ${JSON.stringify(frame)}`);
      this.handleApprovalResponse(frame);
    });

    // 监听进入会话事件
    this.wsClient.on('event.enter_chat', (frame: WsFrame) => {
      logger.log('wecom', '用户进入会话');
      this.wsClient.replyWelcome(frame, {
        msgtype: 'text',
        text: { content: '您好！Claude Code 审批通道已就绪。' },
      });
    });
  }

  private handleMessage(frame: WsFrame) {
    const body = frame.body;
    if (!body) return;

    // 打印完整消息结构（调试用）
    logger.log('wecom', `收到消息帧: ${JSON.stringify(body).substring(0, 500)}`);

    const msgid = body.msgid;
    const from_userid = body.from?.userid || '';
    const msgtype = body.msgtype;
    const chattype = body.chattype || 'single';
    // 群聊时 chatid 在 body.chatid，单聊时就是 from_userid
    const chatid = body.chatid || from_userid;

    let content = '';
    if (msgtype === 'text') {
      content = body.text?.content || '';
    } else if (msgtype === 'mixed') {
      content = (body.mixed?.items || [])
        .filter((i: any) => i.type === 'text')
        .map((i: any) => i.text?.content || '')
        .join('');
    }

    // 提取引用内容（企业微信格式：body.quote.text.content）
    let quoteContent: string | undefined;
    if (body.quote?.text?.content) {
      quoteContent = body.quote.text.content;
    }

    if (quoteContent) {
      logger.log('wecom', `检测到引用内容: ${quoteContent.substring(0, 100)}`);
    }

    if (content) {
      // v3.0: 添加消息序号和队列上限检查
      const msgRecord: MessageRecord = {
        seq: globalMessageSeq++,
        msgid,
        content,
        timestamp: Date.now(),
        serverTime: Date.now(),
        from_userid,
        chatid,
        chattype,
        quoteContent,
      };

      // v3.0: 检查队列上限
      if (this.messages.length >= MAX_PENDING_MESSAGES) {
        const dropped = this.messages.shift();
        logger.warn('wecom', `消息队列已满，丢弃旧消息: ${dropped?.msgid}`);
      }

      this.messages.push(msgRecord);
      const source = chattype === 'group' ? `群聊(${chatid})` : '单聊';
      logger.log('wecom', `收到${source}消息: ${from_userid} -> ${content.slice(0, 100)}`);

      // 发布到消息总线（用于 SSE 推送）
      publishWecomMessage({
        robotName: this.robotName,
        msgid,
        content,
        from_userid,
        chatid,
        chattype,
        timestamp: Date.now(),
        quoteContent,
      });
    }
  }

  private handleApprovalResponse(frame: WsFrame) {
    const event = frame.body?.event;
    logger.log('wecom', `handleApprovalResponse body.event: ${JSON.stringify(event)}`);
    if (!event) {
      logger.log('wecom', `event 为空，frame.body: ${JSON.stringify(frame.body)}`);
      return;
    }

    // task_id 和 event_key 在 event.template_card_event 内部
    const cardEvent = (event as any).template_card_event;
    const taskId = cardEvent?.task_id;
    const eventKey = cardEvent?.event_key; // 用户点击的按钮 key

    logger.log('wecom', `taskId=${taskId}, eventKey=${eventKey}, approvals keys: ${[...this.approvals.keys()].join(',')}`);

    if (!taskId) return;

    logger.log('wecom', `收到审批响应: taskId=${taskId}, key=${eventKey}`);

    const approval = this.approvals.get(taskId);
    if (approval && !approval.resolved) {
      approval.resolved = true;
      approval.result = eventKey as 'allow-once' | 'allow-always' | 'deny';
      approval.timestamp = Date.now();
      this.emit('approval_resolved', { taskId, result: approval.result });

      // 发送确认消息给用户
      const resultText = eventKey === 'allow-once' ? '✅ 已允许（本次）'
        : eventKey === 'allow-always' ? '✅ 已允许（永久）'
        : '❌ 已拒绝';
      const toolInfo = approval.toolName ? `: ${approval.toolName}` : '';
      const descInfo = approval.description ? `\n\n> ${approval.description}` : '';
      const content = `**审批结果**${toolInfo}\n\n${resultText}${descInfo}`;

      this.sendText(content).catch(err => {
        logger.error('wecom', `发送审批确认失败: ${err}`);
      });
    } else if (approval && approval.resolved) {
      logger.log('wecom', `审批已解决，跳过点击: ${taskId}, resolved=${approval.resolved}, result=${approval.result}`);
    } else {
      logger.log('wecom', `审批记录不存在: ${taskId}`);
    }
  }

  // 使用 reply 方法回复审批结果（会有引用效果）
  private async replyApprovalResult(frame: WsFrame, content: string): Promise<void> {
    if (!this.connected) {
      logger.log('wecom', '未连接，无法回复');
      return;
    }

    try {
      await this.wsClient.reply(frame, {
        msgtype: 'markdown',
        markdown: { content },
      });
      logger.log('wecom', '已回复审批结果');
    } catch (err) {
      logger.error('wecom', `回复失败: ${err}`);
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

  // 验证目标用户（尝试发送测试消息）
  async verifyTargetUser(userId?: string): Promise<{ valid: boolean; error?: string }> {
    const targetId = userId || this.targetUserId;
    if (!this.connected) {
      return { valid: false, error: 'WebSocket 未连接' };
    }

    try {
      // 尝试发送一条简单的验证消息（使用 markdown 格式）
      await this.wsClient.sendMessage(targetId, {
        msgtype: 'markdown',
        markdown: { content: '【系统消息】机器人配置验证成功，此消息可忽略。' },
      });
      logger.log('wecom', `用户验证成功: ${targetId}`);
      return { valid: true };
    } catch (err: any) {
      const errorMsg = err.message || String(err);
      logger.error('wecom', `用户验证失败: ${errorMsg}`);

      // 解析错误类型
      if (errorMsg.includes('93006') || errorMsg.includes('invalid chatid')) {
        return { valid: false, error: '用户 ID 格式无效，请使用企业微信通讯录中的"账号"字段（通常是拼音格式，如 liuyang），不是中文名称' };
      } else if (errorMsg.includes('60011') || errorMsg.includes('no privilege')) {
        return { valid: false, error: '用户不在机器人可见范围内，请在企业微信管理后台添加可见范围' };
      } else if (errorMsg.includes('60012') || errorMsg.includes('user not exist')) {
        return { valid: false, error: '用户 ID 不存在，请确认填写的是企业微信通讯录中的"账号"字段' };
      } else if (errorMsg.includes('60013') || errorMsg.includes('not friend')) {
        return { valid: false, error: '用户未添加机器人为好友，请先在企业微信中添加机器人' };
      }

      return { valid: false, error: errorMsg };
    }
  }

  // 发送文本消息（主动推送）
  async sendText(content: string, targetUser?: string): Promise<boolean> {
    const userId = targetUser || this.targetUserId;

    // 断线时将消息加入队列，等待重连后发送
    if (!this.connected) {
      logger.log('wecom', '未连接，消息已加入队列');
      this.pendingMessages.push({
        type: 'text',
        content,
        targetUser: userId,
        timestamp: Date.now(),
      });
      return false;
    }

    try {
      await this.wsClient.sendMessage(userId, {
        msgtype: 'markdown',
        markdown: { content },
      });
      logger.log('wecom', `已发送消息到 ${userId}`);
      return true;
    } catch (err) {
      logger.error('wecom', `发送失败: ${err}`);
      // 发送失败也加入队列
      this.pendingMessages.push({
        type: 'text',
        content,
        targetUser: userId,
        timestamp: Date.now(),
      });
      return false;
    }
  }

  // 发送审批请求（带按钮的模板卡片）
  async sendApprovalRequest(
    title: string,
    description: string,
    requestId: string,
    targetUser?: string,
    toolInput?: Record<string, unknown>,  // v3.0: 用于去重
    ccId?: string                         // v3.0: 参与哈希，防止跨 CC 复用审批
  ): Promise<string> {
    const userId = targetUser || this.targetUserId;

    // 从 title 中提取工具名称（格式: 【待审批】Bash）
    const toolName = title.replace('【待审批】', '');

    // v3.0: 检查是否有相同操作的待处理审批（去重）
    if (toolInput && toolName) {
      const operationHash = hashOperation(ccId ?? '', toolName, toolInput);
      const existing = this.findApprovalByHash(operationHash);

      if (existing) {
        logger.log(`[wecom] 复用已有审批: ${existing.taskId} (hash: ${operationHash.slice(0, 8)}...)`);
        return existing.taskId;
      }
    }

    const taskId = `approval_${requestId}_${Date.now()}`;
    const operationHash = toolInput && toolName ? hashOperation(ccId ?? '', toolName, toolInput) : undefined;

    // 始终存储审批记录（断线时也需要，让 Hook 能轮询到）
    this.approvals.set(taskId, {
      taskId,
      resolved: false,
      timestamp: Date.now(),
      toolName,
      toolInput,
      description,  // 保存审批请求原文
      operationHash,
    });

    // 断线时将审批请求加入队列，等待重连后发送
    if (!this.connected) {
      logger.log('[wecom] 未连接，审批请求已加入队列');
      this.pendingMessages.push({
        type: 'approval',
        content: { title, description, requestId, targetUser: userId, taskId },
        targetUser: userId,
        timestamp: Date.now(),
      });
      // 返回 taskId，审批记录已创建，等待重连后发送
      return taskId;
    }

    // 发送模板卡片
    await this.wsClient.sendMessage(userId, {
      msgtype: 'template_card',
      template_card: {
        card_type: 'button_interaction',
        main_title: { title },
        sub_title_text: description,
        button_list: [
          { text: '允许', key: 'allow-once', style: 1 },
          { text: '默认', key: 'allow-always', style: 1 },
          { text: '拒绝', key: 'deny', style: 2 },
        ],
        task_id: taskId,
      },
    });

    logger.log(`[wecom] 已发送审批请求到 ${userId}: ${taskId}`);
    return taskId;
  }

  // 发送排队的审批请求（使用已存在的 taskId）
  async sendQueuedApproval(
    taskId: string,
    title: string,
    description: string,
    targetUser?: string
  ): Promise<boolean> {
    // 检查审批是否已解决
    const approval = this.approvals.get(taskId);
    if (!approval) {
      logger.log(`[wecom] 审批记录不存在: ${taskId}`);
      return false;
    }
    if (approval.resolved) {
      logger.log(`[wecom] 审批已解决，跳过发送: ${taskId}`);
      return false;
    }

    const userId = targetUser || this.targetUserId;

    // 发送模板卡片
    await this.wsClient.sendMessage(userId, {
      msgtype: 'template_card',
      template_card: {
        card_type: 'button_interaction',
        main_title: { title },
        sub_title_text: description,
        button_list: [
          { text: '允许', key: 'allow-once', style: 1 },
          { text: '默认', key: 'allow-always', style: 1 },
          { text: '拒绝', key: 'deny', style: 2 },
        ],
        task_id: taskId,
      },
    });

    logger.log(`[wecom] 已发送排队审批请求到 ${userId}: ${taskId}`);
    return true;
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

  // 手动设置审批结果（供 Hook 超时自动决策使用）
  setApprovalResult(taskId: string, result: 'allow-once' | 'deny', reason?: string): boolean {
    const approval = this.approvals.get(taskId);
    if (!approval) {
      logger.log(`[wecom] 设置审批结果失败：记录不存在 ${taskId}`);
      return false;
    }
    if (approval.resolved) {
      logger.log(`[wecom] 设置审批结果失败：已解决 ${taskId}`);
      return false;
    }

    approval.resolved = true;
    approval.result = result;
    approval.timestamp = Date.now();
    this.emit('approval_resolved', { taskId, result });

    // 发送确认消息给用户（包含超时原因和原文引用）
    const resultText = result === 'deny' ? '❌ 已拒绝' : '✅ 已允许';
    const reasonText = reason ? `\n\n原因：${reason}` : '';
    const toolInfo = approval.toolName ? `: ${approval.toolName}` : '';
    const descInfo = approval.description ? `\n\n> ${approval.description}` : '';

    this.sendText(`**审批结果（超时自动决策）**${toolInfo}\n\n${resultText}${reasonText}${descInfo}`).catch(err => {
      logger.error('[wecom] 发送审批确认失败:', err);
    });

    logger.log(`[wecom] 超时自动决策已设置: ${taskId} → ${result}`);
    return true;
  }

  // 获取所有待处理的审批任务 ID（供 hook 轮询使用）
  getPendingApprovals(): string[] {
    return Array.from(this.approvals.entries())
      .filter(([_, a]) => !a.resolved)
      .map(([taskId, _]) => taskId);
  }

  // 获取所有待处理审批记录（供保活监控使用）
  getPendingApprovalsRecords(): ApprovalRecord[] {
    return Array.from(this.approvals.values())
      .filter(a => !a.resolved);
  }

  // 获取单个审批记录
  getApprovalRecord(taskId: string): ApprovalRecord | undefined {
    return this.approvals.get(taskId);
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
    // 按序号排序后返回
    return result.sort((a, b) => a.seq - b.seq);
  }

  // ============================================
  // v3.0 新增方法：审批去重
  // ============================================

  /**
   * 根据操作哈希查找已有审批
   */
  findApprovalByHash(operationHash: string): ApprovalRecord | null {
    for (const approval of this.approvals.values()) {
      if (approval.operationHash === operationHash && !approval.resolved) {
        return approval;
      }
    }
    return null;
  }

  /**
   * 检查审批是否可以消费
   * allow-once 只能消费一次
   */
  canConsumeApproval(taskId: string): boolean {
    const approval = this.approvals.get(taskId);
    if (!approval) return false;
    if (!approval.resolved) return false;
    if (approval.result === 'allow-once' && approval.consumed) return false;
    return true;
  }

  /**
   * 消费审批结果
   * allow-once 消费后标记为已消费
   */
  consumeApproval(taskId: string): 'allow-once' | 'allow-always' | 'deny' | null {
    const approval = this.approvals.get(taskId);
    if (!approval || !approval.resolved || !approval.result) return null;

    // 检查是否可消费
    if (approval.result === 'allow-once' && approval.consumed) {
      return null;  // 已消费
    }

    // 标记消费
    if (approval.result === 'allow-once') {
      approval.consumed = true;
    }

    return approval.result;
  }

  /**
   * 注入审批记录（MCP 重启恢复用）
   * 如果 taskId 已存在则跳过，避免覆盖用户已点击的结果
   */
  injectApprovalRecord(
    taskId: string,
    partial: { toolName?: string; toolInput?: Record<string, unknown> }
  ): void {
    if (this.approvals.has(taskId)) return;
    this.approvals.set(taskId, {
      taskId,
      resolved: false,
      timestamp: Date.now(),
      toolName: partial.toolName,
      toolInput: partial.toolInput,
    });
    logger.log(`[wecom] 注入恢复审批记录: ${taskId}`);
  }

  // 清理过期消息
  cleanupMessages(maxAgeMs = 300000) {
    const cutoff = Date.now() - maxAgeMs;
    this.messages = this.messages.filter(m => m.timestamp > cutoff);
    this.approvals.forEach((a, k) => {
      if (a.timestamp < cutoff) this.approvals.delete(k);
    });
    // 清理过期的待发送消息
    this.pendingMessages = this.pendingMessages.filter(m => m.timestamp > cutoff);
  }

  // 刷新待发送消息队列（重连成功后调用）
  private async flushPendingMessages(): Promise<void> {
    if (this.pendingMessages.length === 0) {
      return;
    }

    logger.log(`[wecom] 刷新待发送消息队列: ${this.pendingMessages.length} 条`);

    while (this.pendingMessages.length > 0 && this.connected) {
      const msg = this.pendingMessages.shift();
      if (!msg) break;

      try {
        if (msg.type === 'text') {
          await this.wsClient.sendMessage(msg.targetUser || this.targetUserId, {
            msgtype: 'markdown',
            markdown: { content: msg.content },
          });
        } else if (msg.type === 'approval') {
          // 审批消息：使用原始 taskId 重新发送
          const { title, description, targetUser, taskId } = msg.content;
          const userId = targetUser || this.targetUserId;

          // 发送模板卡片（使用原始 taskId）
          await this.wsClient.sendMessage(userId, {
            msgtype: 'template_card',
            template_card: {
              card_type: 'button_interaction',
              main_title: { title },
              sub_title_text: description,
              button_list: [
                { text: '允许', key: 'allow-once', style: 1 },
                { text: '默认', key: 'allow-always', style: 1 },
                { text: '拒绝', key: 'deny', style: 2 },
              ],
              task_id: taskId,
            },
          });
          logger.log(`[wecom] 重发审批请求: ${taskId}`);
        }
        logger.log(`[wecom] 重发消息成功: ${msg.type}`);
      } catch (err) {
        logger.error(`[wecom] 重发消息失败: ${err}`);
      }
    }
  }

  // 获取待发送消息数量
  getPendingMessageCount(): number {
    return this.pendingMessages.length;
  }

  // 获取重连状态
  getReconnectStatus(): { wasReconnecting: boolean; attempt: number; lastDisconnectTime: number } {
    return {
      wasReconnecting: this.wasReconnecting,
      attempt: this.reconnectAttempt,
      lastDisconnectTime: this.lastDisconnectTime,
    };
  }
}

// 单例实例
let instance: WecomClient | null = null;

export function initClient(botId: string, secret: string, targetUserId: string, robotName: string): WecomClient {
  if (instance) {
    instance.disconnect();
  }
  instance = new WecomClient(botId, secret, targetUserId, robotName);
  instance.connect();
  return instance;
}

export function getClient(): WecomClient {
  if (!instance) {
    throw new Error('WecomClient 未初始化，请先调用 initClient');
  }
  return instance;
}

export { WecomClient, ApprovalRecord, MessageRecord, MAX_PENDING_MESSAGES };