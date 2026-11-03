import { createHash, randomBytes } from 'node:crypto';
import argon2 from 'argon2';

/**
 * 密码策略与哈希（F08）。
 *
 * 策略（与 ADR-0003 一致）：
 * - 长度 12～128 个字符（按 Unicode 码点计）
 * - 至少包含 3 类字符（小写、大写、数字、符号）
 * - 不允许与邮箱本地部分相同
 * - 拒绝少量常见弱口令
 *
 * Argon2id 参数在本机（Windows / 单核 ~3GHz 档位）实测校准：
 * - m=19MiB t=2 → 34ms（偏快，离线爆破成本低）
 * - m=64MiB t=7 → 392ms（选中，落在 0.3～1.0s 目标区间）
 * - m=128MiB t=3 → 349ms（同等耗时但单次内存翻倍，并发登录压力更大）
 * 部署到更慢/更快的机器时用 `pnpm auth:calibrate` 复测并调整。
 */

export const PASSWORD_HASH_PARAMS = {
  type: argon2.argon2id,
  memoryCost: 65_536,
  timeCost: 7,
  parallelism: 1,
} as const;

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

const COMMON_PASSWORDS = new Set([
  'password1234',
  '123456789012',
  'qwertyuiop12',
  'admin1234567',
  'iloveyou1234',
  'letmein12345',
  'welcome12345',
]);

export interface PasswordPolicyViolation {
  code: 'TOO_SHORT' | 'TOO_LONG' | 'TOO_SIMPLE' | 'TOO_COMMON' | 'SAME_AS_EMAIL';
  message: string;
}

export function validatePasswordPolicy(
  password: string,
  emailLocalPart?: string,
): PasswordPolicyViolation[] {
  const violations: PasswordPolicyViolation[] = [];
  const length = [...password].length;

  if (length < PASSWORD_MIN_LENGTH) {
    violations.push({ code: 'TOO_SHORT', message: `密码至少 ${PASSWORD_MIN_LENGTH} 个字符` });
  }
  if (length > PASSWORD_MAX_LENGTH) {
    violations.push({ code: 'TOO_LONG', message: `密码最多 ${PASSWORD_MAX_LENGTH} 个字符` });
  }

  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((pattern) => pattern.test(password)).length;
  if (classes < 3) {
    violations.push({
      code: 'TOO_SIMPLE',
      message: '密码需包含小写字母、大写字母、数字、符号中的至少三类',
    });
  }

  if (COMMON_PASSWORDS.has(password.toLowerCase())) {
    violations.push({ code: 'TOO_COMMON', message: '该密码过于常见，请更换' });
  }

  if (emailLocalPart !== undefined && emailLocalPart.length > 0) {
    if (password.toLowerCase().includes(emailLocalPart.toLowerCase())) {
      violations.push({ code: 'SAME_AS_EMAIL', message: '密码不能包含邮箱名' });
    }
  }

  return violations;
}

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, PASSWORD_HASH_PARAMS);
}

/** 校验密码；哈希损坏时返回 false（不抛错，避免把内部细节暴露给调用方） */
export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

export function needsRehash(hash: string): boolean {
  return argon2.needsRehash(hash, PASSWORD_HASH_PARAMS);
}

/** 会话/恢复令牌：32 字节随机数，URL 安全；数据库只存 SHA-256 */
export function createOpaqueToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, tokenHash: hashOpaqueToken(token) };
}

export function hashOpaqueToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** 邮箱规范化：trim + 小写（与 users.email_normalized 的 CHECK 一致） */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function emailLocalPart(email: string): string {
  const normalized = normalizeEmail(email);
  const at = normalized.indexOf('@');
  return at === -1 ? normalized : normalized.slice(0, at);
}

/** 常数时间比较，避免通过计时差异判断令牌是否正确 */
export function safeEqualHex(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) {
    diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return diff === 0;
}
