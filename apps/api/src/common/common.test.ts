import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { toFieldErrors } from './zod.pipe.js';
import { normalizeRequestId } from './request-context.js';
import { loadConfig, ConfigValidationError } from './config.js';

describe('配置校验', () => {
  const baseEnv = {
    DATABASE_URL: 'postgresql://u:p@127.0.0.1:55432/db?schema=public',
  } satisfies NodeJS.ProcessEnv;

  it('缺少 DATABASE_URL 时抛错并列出问题', () => {
    expect(() => loadConfig({} as NodeJS.ProcessEnv)).toThrow(ConfigValidationError);
    try {
      loadConfig({} as NodeJS.ProcessEnv);
    } catch (error) {
      expect((error as ConfigValidationError).issues.join()).toContain('DATABASE_URL');
    }
  });

  it('合法配置使用默认值', () => {
    const config = loadConfig(baseEnv);
    expect(config.API_PORT).toBe(3001);
    expect(config.NODE_ENV).toBe('development');
    expect(config.COOKIE_SECURE).toBe(false);
    expect(config.SESSION_ABSOLUTE_DAYS).toBe(7);
  });

  it('非法端口被拒绝', () => {
    expect(() => loadConfig({ ...baseEnv, API_PORT: '0' } as NodeJS.ProcessEnv)).toThrow(
      ConfigValidationError,
    );
  });

  it('布尔字符串被正确解析', () => {
    const config = loadConfig({ ...baseEnv, COOKIE_SECURE: 'true' } as NodeJS.ProcessEnv);
    expect(config.COOKIE_SECURE).toBe(true);
  });
});

describe('fieldErrors 映射', () => {
  it('把 zod issues 转成 {字段: [消息]}，未知字段有独立键', () => {
    const schema = z.strictObject({
      title: z.string().min(1, '不能为空'),
      priority: z.enum(['p0', 'p1', 'p2']),
    });
    const result = schema.safeParse({ title: '', priority: 'p9', extra: 1 });
    expect(result.success).toBe(false);
    if (result.success) return;
    const errors = toFieldErrors(result.error);
    expect(errors['title']).toContain('不能为空');
    expect(errors['priority']?.length).toBeGreaterThan(0);
    expect(errors['extra']?.length).toBeGreaterThan(0);
  });
});

describe('requestId 规范化', () => {
  it('接受合法的外部 requestId', () => {
    expect(normalizeRequestId('r-8f2c9a1b')).toBe('r-8f2c9a1b');
  });

  it('拒绝过短、含非法字符或缺失的值并生成新 ID', () => {
    expect(normalizeRequestId(undefined)).toMatch(/^r-[0-9a-f]{12}$/);
    expect(normalizeRequestId('short')).toMatch(/^r-[0-9a-f]{12}$/);
    expect(normalizeRequestId('bad id with spaces')).toMatch(/^r-[0-9a-f]{12}$/);
    expect(normalizeRequestId('x\ninjected')).toMatch(/^r-[0-9a-f]{12}$/);
  });
});
