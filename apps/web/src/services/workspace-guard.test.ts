import { describe, expect, it } from 'vitest';
import { EpochGuard, runScoped } from './workspace-guard';
import { resolveTheme } from '../providers/theme-provider';

describe('EpochGuard（切换空间防串页）', () => {
  it('begin 递增令牌，旧令牌立即失效', () => {
    const guard = new EpochGuard();
    const first = guard.begin();
    expect(guard.isCurrent(first)).toBe(true);

    const second = guard.begin();
    expect(guard.isCurrent(second)).toBe(true);
    expect(guard.isCurrent(first)).toBe(false);
  });

  it('旧作用域的异步结果被标记为 stale，不返回 value', async () => {
    const guard = new EpochGuard();
    let release: (value: string) => void = () => undefined;
    const slow = new Promise<string>((resolve) => {
      release = resolve;
    });

    const pending = runScoped(guard, () => slow);
    guard.begin(); // 模拟切换空间
    release('旧空间数据');

    await expect(pending).resolves.toEqual({ stale: true });
  });

  it('同一作用域内的结果被采用', async () => {
    const guard = new EpochGuard();
    guard.begin();
    await expect(runScoped(guard, async () => '新空间数据')).resolves.toEqual({
      stale: false,
      value: '新空间数据',
    });
  });
});

describe('主题解析', () => {
  it('system 跟随系统偏好', () => {
    expect(resolveTheme('system', 'dark')).toBe('dark');
    expect(resolveTheme('system', 'light')).toBe('light');
  });

  it('显式选择覆盖系统', () => {
    expect(resolveTheme('light', 'dark')).toBe('light');
    expect(resolveTheme('dark', 'light')).toBe('dark');
  });
});
