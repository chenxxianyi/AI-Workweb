import { describe, expect, it } from 'vitest';
import {
  createSessionToken,
  findSetCookie,
  parseCookies,
  safeEqualString,
  serializeClearedCookie,
  serializeCookie,
  sha256Hex,
} from './session.js';
import { checkLoginLock, clearLoginFailures, recordLoginFailure, resetLoginFailures } from './login-throttle.js';

describe('Cookie 工具', () => {
  it('解析多个 Cookie 并忽略畸形片段', () => {
    expect(parseCookies('a=1; b=2; c; =3; d=%E4%B8%AD')).toEqual({ a: '1', b: '2', d: '中' });
  });

  it('空或缺失的 Cookie 头返回空对象', () => {
    expect(parseCookies(undefined)).toEqual({});
    expect(parseCookies('')).toEqual({});
  });

  it('序列化带 HttpOnly/SameSite/Secure/Max-Age', () => {
    const header = serializeCookie('sfs_session', 'abc', {
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      maxAgeSeconds: 60,
      path: '/',
    });
    expect(header).toBe('sfs_session=abc; Path=/; SameSite=Lax; HttpOnly; Secure; Max-Age=60');
  });

  it('清除 Cookie 使用 Max-Age=0', () => {
    expect(serializeClearedCookie('sfs_session', { httpOnly: true, secure: false })).toContain('Max-Age=0');
  });

  it('从 Set-Cookie 数组取出指定 Cookie 的值', () => {
    const headers = ['sfs_csrf=token1; Path=/; SameSite=Lax', 'sfs_session=token2; Path=/; HttpOnly'];
    expect(findSetCookie(headers, 'sfs_csrf')).toBe('token1');
    expect(findSetCookie(headers, 'sfs_session')).toBe('token2');
    expect(findSetCookie(headers, 'missing')).toBeUndefined();
    expect(findSetCookie(undefined, 'x')).toBeUndefined();
  });
});

describe('令牌与哈希', () => {
  it('会话令牌为 URL 安全随机串，哈希稳定', () => {
    const first = createSessionToken();
    const second = createSessionToken();
    expect(first.token).not.toBe(second.token);
    expect(first.token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(sha256Hex(first.token)).toBe(first.tokenHash);
    expect(first.tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('常数时间比较只对相同字符串返回 true', () => {
    expect(safeEqualString('abc', 'abc')).toBe(true);
    expect(safeEqualString('abc', 'abd')).toBe(false);
    expect(safeEqualString('abc', 'abcd')).toBe(false);
  });
});

describe('登录失败锁定', () => {
  it('5 次失败后锁定，并给出重试秒数', () => {
    resetLoginFailures();
    const email = 'lock@example.test';
    const now = 1_000_000;
    for (let index = 0; index < 5; index += 1) recordLoginFailure(email, now);
    const state = checkLoginLock(email, now);
    expect(state.locked).toBe(true);
    expect(state.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('成功登录清零计数', () => {
    resetLoginFailures();
    const email = 'clear@example.test';
    for (let index = 0; index < 4; index += 1) recordLoginFailure(email);
    clearLoginFailures(email);
    expect(checkLoginLock(email).locked).toBe(false);
  });

  it('窗口过期后自动解锁', () => {
    resetLoginFailures();
    const email = 'window@example.test';
    const start = 1_000_000;
    for (let index = 0; index < 5; index += 1) recordLoginFailure(email, start);
    expect(checkLoginLock(email, start + 16 * 60_000).locked).toBe(false);
  });

  it('不同账号互不影响', () => {
    resetLoginFailures();
    for (let index = 0; index < 5; index += 1) recordLoginFailure('a@example.test');
    expect(checkLoginLock('b@example.test').locked).toBe(false);
  });
});
