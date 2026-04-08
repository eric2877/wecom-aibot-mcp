import fs from 'fs';

/**
 * 原子写文件：先写 .tmp 再 rename，避免并发写损坏
 */
export function atomicWriteFileSync(filePath: string, content: string): void {
  const tmp = `${filePath}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, content, 'utf-8');
  fs.renameSync(tmp, filePath);
}
