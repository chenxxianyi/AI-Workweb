import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

/**
 * API 启动入口（F04 最小壳）。
 * F06 会把端口、监听地址、日志级别等改为经 zod 校验的配置模块。
 */
const port = Number(process.env.API_PORT ?? 3001);
const host = process.env.API_HOST ?? '127.0.0.1';

const app = await NestFactory.create(AppModule, {
  logger: ['error', 'warn'],
  abortOnError: true,
});
app.setGlobalPrefix('api/v1');
app.enableShutdownHooks();

await app.listen(port, host);
// eslint-disable-next-line no-console
console.log(`[api] listening on http://${host}:${port}/api/v1`);
