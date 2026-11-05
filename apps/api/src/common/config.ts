import { z } from 'zod';

/**
 * 配置校验（F06）：启动时校验环境变量，缺项或非法直接失败，不用默认值掩盖配置错误。
 * 只有明确的开发默认值（端口、日志级别）才允许缺省。
 */
const booleanFromEnv = z
  .union([z.boolean(), z.enum(['true', 'false'])])
  .transform((value) => (typeof value === 'boolean' ? value : value.toLowerCase() === 'true'));

const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  API_HOST: z.string().min(1).default('127.0.0.1'),
  PUBLIC_ORIGIN: z.url().default('http://127.0.0.1:5173'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL 不能为空：请从 .env.example 复制 .env'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  COOKIE_SECURE: booleanFromEnv.pipe(z.boolean()).default(false),
  SESSION_COOKIE_NAME: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,100}$/)
    .default('sfs_session'),
  CSRF_COOKIE_NAME: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,100}$/)
    .default('sfs_csrf'),
  SESSION_IDLE_MINUTES: z.coerce
    .number()
    .int()
    .min(5)
    .max(60 * 24 * 30)
    .default(1440),
  SESSION_ABSOLUTE_DAYS: z.coerce.number().int().min(1).max(90).default(7),
  RATE_LIMIT_LOGIN_PER_MINUTE: z.coerce.number().int().min(1).max(1000).default(10),
  RATE_LIMIT_SEARCH_PER_MINUTE: z.coerce.number().int().min(1).max(1000).default(60),
  TRANSFER_STORAGE_DIR: z.string().min(1).default('.data/transfers'),
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().min(500).max(60_000).default(5000),
  ENABLE_API_DOCS: booleanFromEnv.pipe(z.boolean()).default(false),
});

export type AppConfig = z.infer<typeof configSchema>;

export class ConfigValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`配置校验失败：\n- ${issues.join('\n- ')}`);
    this.name = 'ConfigValidationError';
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = configSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join('.')}：${issue.message}`);
    throw new ConfigValidationError(issues);
  }
  return parsed.data;
}
