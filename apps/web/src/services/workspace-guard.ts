/**
 * 空间切换守卫（F07）：
 * 切换空间时递增 epoch；异步结果返回时比较 epoch，旧空间的结果一律丢弃，
 * 避免“延迟返回的旧响应覆盖新页面”（F07-02）。
 */
export class EpochGuard {
  private epoch = 0;

  /** 开始一次作用域（如切换空间、切换筛选）并返回令牌 */
  begin(): number {
    this.epoch += 1;
    return this.epoch;
  }

  get current(): number {
    return this.epoch;
  }

  /** 该令牌是否仍属于当前作用域 */
  isCurrent(token: number): boolean {
    return token === this.epoch;
  }
}

export interface ScopedResult<T> {
  stale: boolean;
  value?: T;
}

/** 把守卫与异步结果组合：过期结果不返回 value */
export async function runScoped<T>(
  guard: EpochGuard,
  task: () => Promise<T>,
): Promise<ScopedResult<T>> {
  const token = guard.current;
  const value = await task();
  return guard.isCurrent(token) ? { stale: false, value } : { stale: true };
}
