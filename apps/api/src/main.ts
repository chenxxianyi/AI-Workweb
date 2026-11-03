import 'reflect-metadata';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnvFile } from 'dotenv';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { loadConfig, type AppConfig } from './common/config.js';
import { createAccessLogMiddleware, logger } from './common/logger.js';
import { AllExceptionsFilter } from './common/exception.filter.js';
import { ResponseEnvelopeInterceptor } from './common/response.interceptor.js';

/**
 * API 启动入口（F06）：
 * 1) 先校验配置（不合法直接退出，不用默认值掩盖错误）
 * 2) 请求 ID / 访问日志
 * 3) 统一响应封装与异常过滤
 * 4) 请求体大小限制（契约：普通 JSON ≤ 128KiB）
 */
let config: AppConfig;
try {
  // 先读仓库根 .env（src/main.ts 与 dist/main.js 都在 apps/api/<dir>/ 下，向上三级为仓库根）；
  // 已存在的环境变量优先，生产由容器注入，不依赖文件。
  loadEnvFile({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../../.env'), quiet: true });
  config = loadConfig();
} catch (error) {
  logger.fatal({ err: error }, 'config_invalid');
  process.exitCode = 1;
  throw error;
}

const app = await NestFactory.create<NestExpressApplication>(AppModule, {
  logger: ['error', 'warn'],
  abortOnError: true,
});

app.use(createAccessLogMiddleware(logger));
app.useBodyParser('json', { limit: '128kb' });
app.setGlobalPrefix('api/v1');
app.useGlobalFilters(new AllExceptionsFilter());
app.useGlobalInterceptors(new ResponseEnvelopeInterceptor());
app.enableShutdownHooks();
app.disable('x-powered-by');

await app.listen(config.API_PORT, config.API_HOST);
logger.info(
  {
    port: config.API_PORT,
    host: config.API_HOST,
    env: config.NODE_ENV,
    publicOrigin: config.PUBLIC_ORIGIN,
  },
  'api_started',
);
