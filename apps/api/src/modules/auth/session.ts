import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * 会话与 Cookie 工具（F09）。零依赖，便于在 Nest、CLI 与测试中复用。
 *
 * 规则（ADR-0003）：
 * - Cookie 只存随机不透明令牌，数据库只存其 SHA-256；
 * - HttpOnly + SameSite=Lax + Path=/，HTTPS 下加 Secure；
 * - CSRF 令牌与 cookie 双提交配合会话绑定，写请求必须带 X-CSRF-Token。
 */

export const CSRF_COOKIE_NAME = 'sfs_csrf';
export const CSRF_HEADER_NAME = 'x-csrf-token';

export function createSessionToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, tokenHash: sha256Hex(token) };
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function safeEqualString(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'utf8');
  const rightBuffer = Buffer.from(right, 'utf8');
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

/** 解析 Cookie 请求头；畸形片段忽略而不是抛错 */
export function parseCookies(header: string | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  if (header === undefined || header === '') return result;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    const name = part.slice(0, index).trim();
    const rawValue = part.slice(index + 1).trim();
    if (name === '') continue;
    try {
      result[name] = decodeURIComponent(rawValue);
    } catch {
      result[name] = rawValue;
    }
  }
  return result;
}

export interface CookieOptions {
  maxAgeSeconds?: number;
  secure: boolean;
  httpOnly: boolean;
  sameSite?: 'Lax' | 'Strict' | 'None';
  path?: string;
}

export function serializeCookie(name: string, value: string, options: CookieOptions): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${options.path ?? '/'}`];
  parts.push(`SameSite=${options.sameSite ?? 'Lax'}`);
  if (options.httpOnly) parts.push('HttpOnly');
  if (options.secure) parts.push('Secure');
  if (options.maxAgeSeconds !== undefined) parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAgeSeconds))}`);
  return parts.join('; ');
}

export function serializeClearedCookie(name: string, options: CookieOptions): string {
  return serializeCookie(name, '', { ...options, maxAgeSeconds: 0 });
}

/** 从 Set-Cookie 头里取出某个 cookie 的值（测试与客户端复用） */
export function findSetCookie(headers: string[] | undefined, name: string): string | undefined {
  if (headers === undefined) return undefined;
  for (const header of headers) {
    if (!header.startsWith(`${name}=`)) continue;
    const end = header.indexOf(';');
    return decodeURIComponent(header.slice(name.length + 1, end === -1 ? undefined : end));
  }
  return undefined;
}
