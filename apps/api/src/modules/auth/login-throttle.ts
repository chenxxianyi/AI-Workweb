import { createHash } from 'node:crypto';

/**
 * 登录失败计数（F09）：按账号做轻量锁定，防止在线暴力破解。
 * - 15 分钟内失败 5 次 → 429，直到窗口过去或登录成功清零
 * - 计数在进程内，多实例不共享（本期单机部署；F43 复核）
 * - 只保存邮箱的 SHA-256，不在内存里留明文邮箱
 */
const WINDOW_MS = 15 * 60_000;
const MAX_FAILURES = 5;

interface FailureRecord {
  count: number;
  firstFailureAt: number;
  lastFailureAt: number;
}

const failures = new Map<string, FailureRecord>();

function keyFor(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase(), 'utf8').digest('hex');
}

export interface LockState {
  locked: boolean;
  retryAfterSeconds: number;
}

export function checkLoginLock(email: string, now = Date.now()): LockState {
  const key = keyFor(email);
  const record = failures.get(key);
  if (record === undefined) return { locked: false, retryAfterSeconds: 0 };
  if (now - record.firstFailureAt > WINDOW_MS) {
    failures.delete(key);
    return { locked: false, retryAfterSeconds: 0 };
  }
  if (record.count < MAX_FAILURES) return { locked: false, retryAfterSeconds: 0 };
  return {
    locked: true,
    retryAfterSeconds: Math.max(1, Math.ceil((record.firstFailureAt + WINDOW_MS - now) / 1000)),
  };
}

export function recordLoginFailure(email: string, now = Date.now()): void {
  const key = keyFor(email);
  const record = failures.get(key);
  if (record === undefined || now - record.firstFailureAt > WINDOW_MS) {
    failures.set(key, { count: 1, firstFailureAt: now, lastFailureAt: now });
    return;
  }
  record.count += 1;
  record.lastFailureAt = now;
}

export function clearLoginFailures(email: string): void {
  failures.delete(keyFor(email));
}

/** 仅测试使用：清空全部计数 */
export function resetLoginFailures(): void {
  failures.clear();
}
