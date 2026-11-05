import { NestFactory } from '@nestjs/core';
import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { createPrismaAdapter } from '../src/common/prisma-adapter.js';
import { hashPassword } from '../src/modules/auth/password.js';

type Jar = Record<string, string>;
export async function createTestContext() {
  loadEnv({ path: fileURLToPath(new URL('../../../.env', import.meta.url)), quiet: true });
  const url = process.env['DATABASE_URL_TEST'];
  if (!url) throw new Error('DATABASE_URL_TEST is required');
  const target = new URL(url);
  if (!target.pathname.endsWith('_test') || !['127.0.0.1', 'localhost'].includes(target.hostname))
    throw new Error('Only local disposable *_test databases');
  process.env['DATABASE_URL'] = url;
  process.env['LOG_LEVEL'] = 'error';
  process.env['COOKIE_SECURE'] = 'false';
  process.env['MAINTENANCE_WORKER_ENABLED'] = 'false';
  process.env['RATE_LIMIT_LOGIN_PER_MINUTE'] = '1000';
  process.env['RATE_LIMIT_SEARCH_PER_MINUTE'] = '1000';
  const prisma = new PrismaClient({ adapter: createPrismaAdapter(url) });
  await prisma.$executeRawUnsafe(
    'TRUNCATE users, workspaces, idempotency_records, import_entity_mappings, workspace_user_preferences RESTART IDENTITY CASCADE',
  );
  const { AppModule } = await import('../src/app.module.js');
  const app = await NestFactory.create(AppModule, { logger: ['error'] });
  app.setGlobalPrefix('api/v1');
  await app.listen(0, '127.0.0.1');
  const base =
    'http://127.0.0.1:' + (app.getHttpServer().address() as { port: number }).port + '/api/v1';
  async function call(
    method: string,
    route: string,
    options: { jar?: Jar; csrf?: string; key?: string; version?: number; body?: unknown } = {},
  ) {
    const key =
      options.key ??
      (method === 'POST' &&
      (route === '/workspaces' || /^\/workspaces\/[^/]+\/projects$/.test(route))
        ? globalThis.crypto.randomUUID()
        : undefined);
    const response = await fetch(base + route, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(options.jar
          ? {
              cookie: Object.entries(options.jar)
                .map(([k, v]) => k + '=' + encodeURIComponent(v))
                .join('; '),
            }
          : {}),
        ...(options.csrf ? { 'x-csrf-token': options.csrf } : {}),
        ...(key ? { 'idempotency-key': key } : {}),
        ...(options.version !== undefined ? { 'if-match': '"' + options.version + '"' } : {}),
      },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });
    const json = (await response.json()) as Record<string, unknown>;
    if (options.jar)
      for (const header of response.headers.getSetCookie()) {
        const pair = header.split(';')[0] ?? '';
        const index = pair.indexOf('=');
        if (index > 0)
          options.jar[pair.slice(0, index)] = decodeURIComponent(pair.slice(index + 1));
      }
    return { status: response.status, json };
  }
  async function owner(label: string) {
    const email = label + '@integration.test',
      password = 'Disposable-Integration-2026';
    const user = await prisma.user.create({
      data: {
        emailNormalized: email,
        displayName: label,
        passwordHash: await hashPassword(password),
      },
    });
    const workspace = await prisma.workspace.create({
      data: { name: label, createdBy: user.id, timezone: 'Asia/Shanghai' },
    });
    const membership = await prisma.workspaceMember.create({
      data: { workspaceId: workspace.id, userId: user.id, role: 'owner' },
    });
    const jar: Jar = {};
    await call('GET', '/auth/csrf', { jar });
    const result = await call('POST', '/auth/login', {
      jar,
      csrf: jar['sfs_csrf'],
      body: { email, password },
    });
    if (result.status !== 200) throw new Error('Fixture login failed');
    return { userId: user.id, workspaceId: membership.workspaceId, jar, csrf: jar['sfs_csrf']! };
  }
  return {
    prisma,
    app,
    call,
    owner,
    base,
    async close() {
      await app.close();
      await prisma.$disconnect();
    },
  };
}
