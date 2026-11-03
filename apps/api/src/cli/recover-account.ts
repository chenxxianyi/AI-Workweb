#!/usr/bin/env node
import { argValue, loadCliEnv, requireDatabaseUrl } from './cli-env.js';
import { createCliPrisma } from './db.js';
import { issueRecoveryToken } from '../modules/auth/auth-core.js';

/**
 * 签发账号恢复令牌（F08）。
 *
 * 用法：
 *   pnpm auth:recover --email owner@example.com [--ttl 30]
 *
 * 规则：
 * - 仅服务器可执行；令牌 30 分钟有效、一次性、只存 SHA-256。
 * - 明文令牌只输出一次，需通过安全渠道交给本人；不要贴到聊天或工单。
 * - 命令不打印密码、哈希或数据库连接串。
 */
loadCliEnv();
const argv = process.argv.slice(2);
const email = argValue(argv, 'email');
const ttlRaw = argValue(argv, 'ttl');
const ttl = ttlRaw === undefined ? 30 : Number(ttlRaw);

if (email === undefined) {
  console.error('用法：pnpm auth:recover --email <邮箱> [--ttl 30]');
  process.exit(2);
}
if (!Number.isInteger(ttl) || ttl < 5 || ttl > 120) {
  console.error('--ttl 必须是 5～120 之间的整数（分钟）');
  process.exit(2);
}

const prisma = createCliPrisma(requireDatabaseUrl());

try {
  const issued = await issueRecoveryToken(prisma, { email, ttlMinutes: ttl });
  if (issued === null) {
    console.error('未找到可用账号（账号不存在或已停用）。');
    process.exitCode = 1;
  } else {
    const origin = process.env['PUBLIC_ORIGIN'] ?? 'http://127.0.0.1:5173';
    console.log('已签发一次性恢复令牌（请通过安全渠道交给本人）：');
    console.log(`  有效期至：${issued.expiresAt.toISOString()}`);
    console.log(`  恢复令牌：${issued.token}`);
    console.log(`  使用地址：${origin}/reset-password?token=${issued.token}`);
    console.log('完成后该令牌立即失效；旧令牌在签发时已作废。');
  }
} catch (error) {
  console.error(`签发失败：${(error as Error).message}`);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
