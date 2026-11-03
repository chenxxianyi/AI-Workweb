import 'reflect-metadata';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnvFile } from 'dotenv';

/**
 * CLI 公共引导（F08）：加载仓库根 .env，创建 Prisma 客户端。
 * CLI 不启动 Nest，避免把服务器进程的依赖带进一次性命令。
 */
export function loadCliEnv(): void {
  loadEnvFile({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../../.env'), quiet: true });
}

export function requireDatabaseUrl(): string {
  const url = process.env['DATABASE_URL'];
  if (url === undefined || url === '') {
    throw new Error('缺少 DATABASE_URL：请在仓库根 .env 中配置，或通过环境变量传入');
  }
  return url;
}

/** 从 argv 读取 `--key value` 形式的参数（缺省返回 undefined） */
export function argValue(argv: string[], key: string): string | undefined {
  const index = argv.indexOf(`--${key}`);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  return value === undefined || value.startsWith('--') ? undefined : value;
}

export function hasFlag(argv: string[], key: string): boolean {
  return argv.includes(`--${key}`);
}

/** 从 stdin 读取一行（用于 --password-stdin，避免密码进入 shell 历史） */
export async function readStdinLine(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8').split(/\r?\n/)[0] ?? '';
}
