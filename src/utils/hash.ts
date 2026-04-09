/**
 * 操作哈希工具
 *
 * 用于审批去重：相同操作复用已有审批
 */

import * as crypto from 'crypto';

/**
 * 生成操作哈希
 *
 * @param ccId Claude Code 实例 ID
 * @param toolName 工具名称
 * @param toolInput 工具输入
 * @returns 哈希字符串
 */
export function hashOperation(
  ccId: string,
  toolName: string,
  toolInput: Record<string, unknown>
): string {
  // 标准化工具输入（按键排序）
  const normalizedInput = JSON.stringify(toolInput, Object.keys(toolInput).sort());

  // 组合字符串
  const content = `${ccId}:${toolName}:${normalizedInput}`;

  // 生成 SHA256 哈希
  return crypto.createHash('sha256').update(content).digest('hex');
}