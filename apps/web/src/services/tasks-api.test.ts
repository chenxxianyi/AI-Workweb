import { describe, expect, it } from 'vitest';
import { newIdempotencyKey, PRIORITY_LABEL } from './tasks-api';

describe('任务接口辅助（F16）', () => {
  it('幂等键唯一且符合后端格式', () => {
    const keys = new Set(Array.from({ length: 50 }, () => newIdempotencyKey()));
    expect(keys.size).toBe(50);
    for (const key of keys) {
      expect(key).toMatch(/^[A-Za-z0-9._:-]+$/);
      expect(key.length).toBeGreaterThanOrEqual(8);
      expect(key.length).toBeLessThanOrEqual(128);
    }
  });

  it('优先级文案与契约一致', () => {
    expect(PRIORITY_LABEL.p0).toBe('P0');
    expect(PRIORITY_LABEL.p1).toBe('P1');
    expect(PRIORITY_LABEL.p2).toBe('P2');
  });
});
