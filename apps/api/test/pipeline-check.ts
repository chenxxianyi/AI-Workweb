import { Writable } from 'node:stream';
import { Body, Controller, Module, Post, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { z } from 'zod';
import { ZodPipe } from '../src/common/zod.pipe.js';
import { ApiException } from '../src/common/api-exception.js';
import { AllExceptionsFilter } from '../src/common/exception.filter.js';
import { ResponseEnvelopeInterceptor } from '../src/common/response.interceptor.js';
import { createAccessLogMiddleware, createLogger } from '../src/common/logger.js';
import { HealthController } from '../src/modules/health/health.controller.js';
import { PrismaService } from '../src/common/prisma.module.js';

/**
 * F06 验收脚本：用真实 HTTP 请求验证 API 基础管道。
 * 用 tsx 运行（需要装饰器），不依赖 vitest 的装饰器转换：
 *   pnpm --filter @aiwb/api test:pipeline
 */

const createTaskSchema = z.strictObject({
  title: z.string().min(1, '不能为空'),
  priority: z.enum(['p0', 'p1', 'p2']),
});

@Controller('test')
class TestController {
  @Post('tasks')
  create(@Body(new ZodPipe(createTaskSchema)) dto: { title: string; priority: string }) {
    return { id: 't-1', ...dto };
  }

  @Post('conflict')
  conflict(): never {
    throw new ApiException('PRECONDITION_FAILED', '该记录已被其他设备修改', { currentVersion: 4 });
  }

  @Post('boom')
  boom(): never {
    throw new Error('connect failed postgresql://aiwb:secret@127.0.0.1:55432/aiwb_dev');
  }
}

@Module({ controllers: [TestController] })
class TestModule {}

class StubPrismaDown {
  async isReady(): Promise<boolean> {
    return false;
  }
}
class StubPrismaUp {
  async isReady(): Promise<boolean> {
    return true;
  }
}

@Module({
  controllers: [HealthController],
  providers: [{ provide: PrismaService, useClass: StubPrismaDown }],
})
class HealthDownModule {}

@Module({
  controllers: [HealthController],
  providers: [{ provide: PrismaService, useClass: StubPrismaUp }],
})
class HealthUpModule {}

interface CheckResult {
  name: string;
  ok: boolean;
  detail?: string;
}
const results: CheckResult[] = [];
function check(name: string, fn: () => void): void {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, detail: (error as Error).message });
  }
}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

async function startApp(moduleRef: unknown): Promise<{ app: INestApplication; base: string }> {
  const moduleFixture = await Test.createTestingModule({ imports: [moduleRef as never] }).compile();
  const app = moduleFixture.createNestApplication();
  app.use(createAccessLogMiddleware());
  app.setGlobalPrefix('api/v1');
  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalInterceptors(new ResponseEnvelopeInterceptor());
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address() as { port: number };
  return { app, base: `http://127.0.0.1:${address.port}/api/v1` };
}

interface CallResult {
  status: number;
  body: Record<string, unknown> & {
    data?: Record<string, unknown>;
    error?: { code: string; message: string; fieldErrors?: Record<string, string[]>; currentVersion?: number };
    requestId?: string;
  };
  requestIdHeader: string | null;
}

async function call(
  base: string,
  path: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<CallResult> {
  const response = await fetch(`${base}${path}`, {
    method: init.method ?? 'POST',
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await response.text();
  const body = text === '' ? {} : (JSON.parse(text) as CallResult['body']);
  return { status: response.status, body, requestIdHeader: response.headers.get('x-request-id') };
}

const { app, base } = await startApp(TestModule);

// 1. 成功响应信封
const ok1 = await call(base, '/test/tasks', { body: { title: '写测试', priority: 'p1' } });
check('成功响应带 data 与 requestId，且与响应头一致', () => {
  assert(ok1.status === 201, `状态应为 201，实际 ${ok1.status}`);
  assert(ok1.body.data?.['title'] === '写测试', 'data.title 不正确');
  assert(typeof ok1.body.requestId === 'string', '缺少 requestId');
  assert(ok1.requestIdHeader === ok1.body.requestId, 'X-Request-Id 与响应体不一致');
});

// 2. 外部 requestId 透传
const ok2 = await call(base, '/test/tasks', {
  body: { title: '透传', priority: 'p2' },
  headers: { 'x-request-id': 'r-external123' },
});
check('合法外部 requestId 透传', () => {
  assert(ok2.status === 201, `状态应为 201，实际 ${ok2.status}`);
  assert(ok2.requestIdHeader === 'r-external123', '未透传外部 requestId');
  assert(ok2.body.requestId === 'r-external123', '响应体 requestId 不一致');
});

// 3. 缺字段 → 422
const bad1 = await call(base, '/test/tasks', { body: { priority: 'p0' } });
check('缺字段返回 422 且 fieldErrors 指向 title', () => {
  assert(bad1.status === 422, `状态应为 422，实际 ${bad1.status}`);
  assert(bad1.body.error?.code === 'VALIDATION_FAILED', `错误码应 VALIDATION_FAILED，实际 ${bad1.body.error?.code}`);
  const titleErrors = bad1.body.error?.fieldErrors?.['title'];
  assert(Array.isArray(titleErrors) && titleErrors.length > 0, 'fieldErrors.title 应非空');
});

// 4. 未知字段严格拒绝
const bad2 = await call(base, '/test/tasks', {
  body: { title: 'x', priority: 'p0', workspaceId: 'forged' },
});
check('未知字段 workspaceId 被拒绝', () => {
  assert(bad2.status === 422, `状态应为 422，实际 ${bad2.status}`);
  assert(
    Object.keys(bad2.body.error?.fieldErrors ?? {}).includes('workspaceId'),
    `fieldErrors 应含 workspaceId，实际 ${JSON.stringify(bad2.body.error?.fieldErrors)}`,
  );
});

// 5. 业务异常映射
const conflict = await call(base, '/test/conflict', { body: {} });
check('业务异常映射 412 + currentVersion', () => {
  assert(conflict.status === 412, `状态应为 412，实际 ${conflict.status}`);
  assert(conflict.body.error?.code === 'PRECONDITION_FAILED', '错误码不正确');
  assert(conflict.body.error?.currentVersion === 4, 'currentVersion 应透传');
});

// 6. 未知异常不泄露
const boom = await call(base, '/test/boom', { body: {} });
check('未知异常 500 且不泄露连接串/堆栈', () => {
  assert(boom.status === 500, `状态应为 500，实际 ${boom.status}`);
  assert(boom.body.error?.code === 'INTERNAL_ERROR', '错误码应为 INTERNAL_ERROR');
  assert(boom.body.error?.message === '服务器内部错误，请稍后重试', 'message 应通用');
  const serialized = JSON.stringify(boom.body);
  assert(!serialized.includes('postgresql://'), '响应泄露连接串');
  assert(!serialized.includes('secret'), '响应泄露口令');
  assert(!serialized.includes('stack'), '响应泄露堆栈');
});

// 7. 404 / 405
const notFound = await call(base, '/nope', { method: 'GET' });
check('未知路由 404 NOT_FOUND', () => {
  assert(notFound.status === 404, `状态应为 404，实际 ${notFound.status}`);
  assert(notFound.body.error?.code === 'NOT_FOUND', '错误码应为 NOT_FOUND');
});

const wrongMethod = await call(base, '/test/tasks', { method: 'GET' });
check('不支持的方法不会落到 500（Nest 映射为 404）', () => {
  assert(wrongMethod.status === 404, `状态应为 404，实际 ${wrongMethod.status}`);
  assert(wrongMethod.body.error?.code === 'NOT_FOUND', '错误码应为 NOT_FOUND');
});

await app.close();

// 8. 数据库不可用：ready 503、live 200
const down = await startApp(HealthDownModule);
const ready503 = await call(down.base, '/health/ready', { method: 'GET' });
check('DB 不可用：ready=503 且不泄露内部信息', () => {
  assert(ready503.status === 503, `状态应为 503，实际 ${ready503.status}`);
  assert(ready503.body.error?.code === 'SERVICE_UNAVAILABLE', '错误码应为 SERVICE_UNAVAILABLE');
  const serialized = JSON.stringify(ready503.body);
  assert(!serialized.includes('postgres'), '响应泄露数据库类型');
  assert(!serialized.includes('127.0.0.1'), '响应泄露主机');
});

const live200 = await call(down.base, '/health/live', { method: 'GET' });
check('DB 不可用：live=200（只反映进程）', () => {
  assert(live200.status === 200, `状态应为 200，实际 ${live200.status}`);
  assert(live200.body.data?.['status'] === 'ok', 'live 状态不正确');
});
await down.app.close();

// 9. 数据库可用：ready 200
const up = await startApp(HealthUpModule);
const ready200 = await call(up.base, '/health/ready', { method: 'GET' });
check('DB 可用：ready=200 且 checks.database=up', () => {
  assert(ready200.status === 200, `状态应为 200，实际 ${ready200.status}`);
  const checks = ready200.body.data?.['checks'] as { database?: string } | undefined;
  assert(checks?.database === 'up', 'checks.database 应为 up');
});
await up.app.close();

// 10. 日志脱敏
check('日志脱敏且保留 requestId', () => {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      lines.push(chunk.toString('utf8'));
      callback();
    },
  });
  const log = createLogger('info', stream);
  log.info(
    {
      requestId: 'r-abc123',
      password: 'plain-secret',
      token: 'tok_123456',
      req: { headers: { cookie: 'sfs_session=abc', authorization: 'Bearer xyz' } },
      email: 'owner@example.test',
    },
    'login_attempt',
  );
  const output = lines.join('');
  assert(output.includes('[redacted]'), '未出现 [redacted]');
  for (const secret of ['plain-secret', 'tok_123456', 'sfs_session=abc', 'Bearer xyz']) {
    assert(!output.includes(secret), `日志泄露：${secret}`);
  }
  assert(output.includes('r-abc123'), '日志缺少 requestId');
  assert(output.includes('owner@example.test'), '非敏感字段被误删');
});

// ---- 汇总 ----
const failed = results.filter((item) => !item.ok);
for (const item of results) {
  console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.name}${item.ok ? '' : `  ← ${item.detail ?? ''}`}`);
}
console.log(`\n合计 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`);
process.exitCode = failed.length === 0 ? 0 : 1;
