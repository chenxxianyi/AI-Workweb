import { describe, expect, it } from 'vitest';
import {
  createOpaqueToken,
  emailLocalPart,
  hashOpaqueToken,
  normalizeEmail,
  PASSWORD_MIN_LENGTH,
  safeEqualHex,
  validatePasswordPolicy,
} from './password.js';

describe('密码策略', () => {
  it('接受强密码', () => {
    expect(validatePasswordPolicy('Str0ng-Passphrase-42')).toEqual([]);
  });

  it('拒绝过短密码', () => {
    const violations = validatePasswordPolicy('Ab1!');
    expect(violations.map((item) => item.code)).toContain('TOO_SHORT');
  });

  it('拒绝字符类别不足的密码', () => {
    const violations = validatePasswordPolicy('alllowercaseletters');
    expect(violations.map((item) => item.code)).toContain('TOO_SIMPLE');
  });

  it('拒绝常见弱口令', () => {
    const violations = validatePasswordPolicy('Password1234');
    expect(violations.map((item) => item.code)).toContain('TOO_COMMON');
  });

  it('拒绝包含邮箱名的密码', () => {
    const violations = validatePasswordPolicy('owner-Strong-42', 'owner');
    expect(violations.map((item) => item.code)).toContain('SAME_AS_EMAIL');
  });

  it('长度以码点计（中文算一个字符）', () => {
    const password = '密码'.repeat(PASSWORD_MIN_LENGTH / 2) + 'Aa1!';
    expect([...password].length).toBeGreaterThanOrEqual(PASSWORD_MIN_LENGTH);
    expect(validatePasswordPolicy(password).some((item) => item.code === 'TOO_SHORT')).toBe(false);
  });
});

describe('邮箱与令牌工具', () => {
  it('邮箱规范化并取本地部分', () => {
    expect(normalizeEmail('  Owner@Example.TEST ')).toBe('owner@example.test');
    expect(emailLocalPart('Owner@Example.TEST')).toBe('owner');
    expect(emailLocalPart('no-at-sign')).toBe('no-at-sign');
  });

  it('令牌为 URL 安全随机串，哈希稳定且不可逆还原', () => {
    const first = createOpaqueToken();
    const second = createOpaqueToken();
    expect(first.token).not.toBe(second.token);
    expect(first.token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(first.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashOpaqueToken(first.token)).toBe(first.tokenHash);
  });

  it('常数时间比较只对相同值返回 true', () => {
    const hash = 'a'.repeat(64);
    expect(safeEqualHex(hash, hash)).toBe(true);
    expect(safeEqualHex(hash, 'b'.repeat(64))).toBe(false);
    expect(safeEqualHex(hash, 'a'.repeat(63))).toBe(false);
  });
});
