import { Global, Inject, Injectable, Module, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { createPrismaAdapter } from './prisma-adapter.js';
import { PrismaClient } from '../generated/prisma/client.js';
import { loadConfig, type AppConfig } from './config.js';

export const APP_CONFIG = Symbol('APP_CONFIG');

@Global()
@Module({
  providers: [
    {
      provide: APP_CONFIG,
      useFactory: (): AppConfig => loadConfig(),
    },
  ],
  exports: [APP_CONFIG],
})
export class ConfigModule {}

/**
 * Prisma 服务（F06）：
 * - 单一连接池实例，进程退出时断开
 * - `isReady()` 用 `SELECT 1` 探测数据库，供 readiness 使用（错误不外泄）
 * - `withTransaction()` 是业务事务的唯一入口（ADR-0004）
 */
@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  private readonly client: PrismaClient;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    const adapter = createPrismaAdapter(config.DATABASE_URL);
    this.client = new PrismaClient({ adapter });
  }

  get db(): PrismaClient {
    return this.client;
  }

  async onModuleInit(): Promise<void> {
    // 惰性连接：启动时不因数据库暂时不可用而崩溃，由 readiness 反映真实状态
    void this.client.$connect().catch(() => undefined);
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.$disconnect();
  }

  async isReady(): Promise<boolean> {
    try {
      await this.client.$queryRaw`SELECT 1`;
      return true;
    } catch {
      return false;
    }
  }

  async withTransaction<T>(fn: (tx: PrismaClient) => Promise<T>): Promise<T> {
    return this.client.$transaction(async (tx) => fn(tx as unknown as PrismaClient), {
      maxWait: 5_000,
      timeout: 15_000,
      isolationLevel: 'ReadCommitted',
    });
  }
}

@Global()
@Module({
  imports: [ConfigModule],
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
