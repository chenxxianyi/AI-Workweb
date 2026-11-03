#!/usr/bin/env node
import { argValue, hasFlag, loadCliEnv, readStdinLine, requireDatabaseUrl } from './cli-env.js';
import { createCliPrisma } from './db.js';
import { bootstrapOwner } from '../modules/auth/auth-core.js';

/**
 * 初始化首个 Owner 与个人空间（F08）。
 *
 * 用法：
 *   pnpm auth:bootstrap --email owner@example.com --name "张三" --password-stdin
 *   echo '强密码' | pnpm auth:bootstrap --email owner@example.com --name "张三" --password-stdin
 *
 * 规则：
 * - 公开注册关闭；本命令是唯一的创建入口，不内置任何默认密码。
 * - 幂等：重复执行同一邮箱不会重复建账号；库中已有其他用户时拒绝再建 Owner。
 * - 密码只从 stdin 读取（避免进入 shell 历史与进程列表），且不打印回显。
 */
loadCliEnv();
const argv = process.argv.slice(2);
const email = argValue(argv, 'email');
const displayName = argValue(argv, 'name');
const passwordStdin = hasFlag(argv, 'password-stdin');
const workspaceName = argValue(argv, 'workspace');
const timezone = argValue(argv, 'timezone');

if (email === undefined || displayName === undefined || !passwordStdin) {
  console.error(
    '用法：pnpm auth:bootstrap --email <邮箱> --name <显示名> --password-stdin [--workspace 个人工作台] [--timezone Asia/Shanghai]',
  );
  process.exit(2);
}

const password = (await readStdinLine()).trimEnd();
if (password === '') {
  console.error('未从 stdin 读到密码');
  process.exit(2);
}

const prisma = createCliPrisma(requireDatabaseUrl());

try {
  const result = await bootstrapOwner(prisma, {
    email,
    displayName,
    password,
    ...(workspaceName === undefined ? {} : { workspaceName }),
    ...(timezone === undefined ? {} : { timezone }),
  });

  if (result.created) {
    console.log('已创建 Owner 与个人空间：');
    console.log(`  用户：${email}`);
    console.log(`  用户 ID：${result.userId}`);
    console.log(`  空间 ID：${result.workspaceId}`);
    console.log('下一步：使用该账号登录（登录接口在 F09 接入）。');
  } else if (result.reason === 'USER_EXISTS') {
    console.log(`该邮箱已存在，未重复创建：${email}`);
    if (result.workspaceId !== undefined) console.log(`  已有空间 ID：${result.workspaceId}`);
  } else {
    console.log('库中已存在其他用户，拒绝创建第二个 Owner。');
    console.log('如需新增成员，请在空间内使用邀请（F10）；如需恢复访问，请用 pnpm auth:recover。');
    process.exitCode = 1;
  }
} catch (error) {
  // 只打印可读原因，不打印密码或哈希
  console.error(`初始化失败：${(error as Error).message}`);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
