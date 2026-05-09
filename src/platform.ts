/**
 * 跨平台辅助函数（Windows / macOS / Linux）
 *
 * 用于替代 ps / lsof / ss / kill 等 Unix 专属命令，
 * 让 daemon 启停、Claude 进程树查找在 Windows 也能工作。
 */
import { execSync } from 'child_process';

const IS_WIN = process.platform === 'win32';

/** 通过 fetch /health 探测 daemon 是否在该端口监听（跨平台） */
export async function isDaemonAlive(port: number, timeoutMs = 1500): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return false;
    const data = await res.json().catch(() => ({})) as any;
    return data?.status === 'ok';
  } catch {
    return false;
  }
}

/** 取指定 PID 的父进程 PID；不存在返回 0 */
export function getParentPid(pid: number): number {
  if (!pid || pid <= 1) return 0;
  try {
    if (IS_WIN) {
      // 输出形如:
      //   ParentProcessId
      //   1234
      const out = execSync(`wmic process where ProcessId=${pid} get ParentProcessId /value`, {
        stdio: ['ignore', 'pipe', 'ignore'],
      }).toString();
      const m = out.match(/ParentProcessId=(\d+)/);
      return m ? parseInt(m[1], 10) : 0;
    } else {
      const out = execSync(`ps -o ppid= -p ${pid}`, {
        stdio: ['ignore', 'pipe', 'ignore'],
      }).toString().trim();
      return parseInt(out, 10) || 0;
    }
  } catch {
    return 0;
  }
}

/** 取指定 PID 的可执行文件名（comm 字段，如 "claude" / "node") */
export function getProcessName(pid: number): string {
  if (!pid || pid <= 1) return '';
  try {
    if (IS_WIN) {
      // wmic process where ProcessId=N get Name /value -> Name=node.exe
      const out = execSync(`wmic process where ProcessId=${pid} get Name /value`, {
        stdio: ['ignore', 'pipe', 'ignore'],
      }).toString();
      const m = out.match(/Name=(.+?)\s*$/m);
      return (m ? m[1] : '').trim();
    } else {
      return execSync(`ps -p ${pid} -o comm=`, {
        stdio: ['ignore', 'pipe', 'ignore'],
      }).toString().trim();
    }
  } catch {
    return '';
  }
}

/**
 * 沿进程树向上查找 Claude Code 进程的 PID。
 * 用于 channel-server 注册 active-projects 时定位真正的 TUI 进程
 * （npx 安装下 process.ppid 是 npx 不是 claude）。
 */
export function findClaudePid(startPid: number, maxDepth = 8): number {
  let pid = startPid;
  for (let i = 0; i < maxDepth; i++) {
    if (!pid || pid <= 1) break;
    const name = getProcessName(pid).toLowerCase();
    // Win 上是 "claude.exe"；Unix 上可能是 "claude" 或绝对路径末尾 "/claude"
    if (name === 'claude' || name === 'claude.exe' || name.endsWith('/claude') || name.endsWith('\\claude.exe')) {
      return pid;
    }
    const parent = getParentPid(pid);
    if (!parent || parent === pid) break;
    pid = parent;
  }
  return startPid;
}

/** 进程是否还在（process.kill(pid, 0) 在 Win/Unix 都可用） */
export function isProcessAlive(pid: number): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
