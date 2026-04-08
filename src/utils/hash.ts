import crypto from 'crypto';

/**
 * 为审批操作生成去重哈希
 * 包含 ccId 防止跨 CC 复用同一审批
 */
export function hashOperation(ccId: string, toolName: string, toolInput: object): string {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({ ccId, toolName, toolInput }))
    .digest('hex')
    .slice(0, 16);
}
