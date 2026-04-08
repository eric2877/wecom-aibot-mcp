/**
 * 审批管理器
 *
 * 负责：
 * 1. 存储 pendingApprovals Map（http-server 审批记录）
 * 2. 持久化到 approval-state.json，MCP 重启后恢复
 * 3. 恢复时将 approvalRecord 注入对应的 WecomClient
 *
 * 与 WecomClient.approvals 的关系：
 * - WecomClient.approvals 记录企业微信卡片状态（用户点击后更新）
 * - approval-manager 记录 http-server 层的审批条目
 * - MCP 重启后，WecomClient 实例是全新的，需要 injectApprovalRecord 恢复
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { atomicWriteFileSync } from './utils/atomic-write.js';

export interface ApprovalEntry {
  taskId: string;
  status: 'pending' | 'allow-once' | 'allow-always' | 'deny';
  timestamp: number;
  tool_name: string;
  tool_input: Record<string, unknown>;
  description: string;
  robotName: string;
}

const pendingApprovals: Map<string, ApprovalEntry> = new Map();

// 支持测试环境覆盖
let CONFIG_DIR = path.join(os.homedir(), '.wecom-aibot-mcp');
let APPROVAL_STATE_FILE = path.join(CONFIG_DIR, 'approval-state.json');

/**
 * 设置配置目录（仅用于测试）
 */
export function setConfigDir(dir: string): void {
  CONFIG_DIR = dir;
  APPROVAL_STATE_FILE = path.join(CONFIG_DIR, 'approval-state.json');
}

let saveInterval: NodeJS.Timeout | null = null;

// ────────────────────────────────────────────
// 审批 CRUD
// ────────────────────────────────────────────

export function addApproval(entry: ApprovalEntry): void {
  pendingApprovals.set(entry.taskId, entry);
}

export function getApproval(taskId: string): ApprovalEntry | undefined {
  return pendingApprovals.get(taskId);
}

export function updateApprovalStatus(
  taskId: string,
  status: 'allow-once' | 'allow-always' | 'deny'
): void {
  const entry = pendingApprovals.get(taskId);
  if (entry) {
    entry.status = status;
    // 审批完成后从 Map 中移除，避免 pendingApprovals.size 持续增长
    pendingApprovals.delete(taskId);
  }
}

export function getPendingApprovals(): Map<string, ApprovalEntry> {
  return pendingApprovals;
}

// ────────────────────────────────────────────
// 持久化
// ────────────────────────────────────────────

export function saveApprovalState(): void {
  const approvals: Array<{ taskId: string; entry: ApprovalEntry }> = [];

  for (const [taskId, entry] of pendingApprovals) {
    if (entry.status === 'pending') {
      approvals.push({ taskId, entry });
    }
  }

  // 无待处理审批时不创建文件
  if (approvals.length === 0) return;

  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    atomicWriteFileSync(
      APPROVAL_STATE_FILE,
      JSON.stringify({ approvals, savedAt: Date.now() }, null, 2)
    );
    console.log(`[approval-manager] 已保存 ${approvals.length} 个待处理审批`);
  } catch (err) {
    console.error('[approval-manager] 保存审批状态失败:', err);
  }
}

/**
 * 从文件恢复审批状态，并将审批记录注入对应的 WecomClient
 * 需在 connectAllRobots() 完成后调用，确保 client 已存在
 */
export async function loadApprovalState(
  getClientFn: (robotName: string) => Promise<import('./client.js').WecomClient | null>
): Promise<void> {
  if (!fs.existsSync(APPROVAL_STATE_FILE)) return;

  try {
    const content = fs.readFileSync(APPROVAL_STATE_FILE, 'utf-8');
    const state = JSON.parse(content) as {
      approvals: Array<{ taskId: string; entry: ApprovalEntry }>;
      savedAt: number;
    };

    // 只恢复 10 分钟内的 pending 审批（超时的不再有效）
    const now = Date.now();
    const maxAge = 10 * 60 * 1000;
    let restored = 0;

    for (const { taskId, entry } of state.approvals) {
      if (entry.status === 'pending' && now - entry.timestamp < maxAge) {
        pendingApprovals.set(taskId, entry);

        // 将审批记录注入对应 WecomClient，使用户点击后能正确路由
        const client = await getClientFn(entry.robotName);
        if (client) {
          client.injectApprovalRecord(taskId, {
            toolName: entry.tool_name,
            toolInput: entry.tool_input,
          });
          console.log(`[approval-manager] 恢复审批: ${taskId} → robot=${entry.robotName}`);
          restored++;
        } else {
          console.warn(`[approval-manager] 恢复审批 ${taskId} 失败：机器人 ${entry.robotName} 不在线`);
        }
      }
    }

    // 恢复完成，删除持久化文件
    fs.unlinkSync(APPROVAL_STATE_FILE);
    console.log(`[approval-manager] 共恢复 ${restored} 个审批`);
  } catch (err) {
    console.warn('[approval-manager] 恢复审批状态失败:', err);
  }
}

// ────────────────────────────────────────────
// 定时保存
// ────────────────────────────────────────────

export function startAutoSave(): void {
  if (saveInterval) return;
  saveInterval = setInterval(() => {
    if (pendingApprovals.size > 0) {
      saveApprovalState();
    }
  }, 30000);
}

export function stopAutoSave(): void {
  if (saveInterval) {
    clearInterval(saveInterval);
    saveInterval = null;
  }
}
