# FS006 验收证据 · F06 实现API基础校验异常与日志

> 执行日期：2026-11-03（Asia/Shanghai）｜执行人：开发执行人（AI 编码代理）
> 环境：Node 22.23.4 · NestJS 12.3.2 · zod 4.6.7 · pino 10.4.0 · PostgreSQL 17.11（127.0.0.1:55432）

## 1. 交付物

| 文件 | 说明 |
|---|---|
| `apps/api/src/common/config.ts` | zod 配置校验；缺 `DATABASE_URL` 或端口越界即启动失败 |
| `apps/api/src/common/request-context.ts` | AsyncLocalStorage 传递 requestId；外部 ID 只接受受限字符 |
| `apps/api/src/common/logger.ts` | pino JSON 日志；`REDACT_PATHS` 脱敏；访问日志中间件 |
| `apps/api/src/common/api-exception.ts` | 错误码 + HTTP 状态绑定的业务异常 |
| `apps/api/src/common/exception.filter.ts` | 全局异常过滤：统一信封、Prisma 错误映射、5xx 仅通用文案 |
| `apps/api/src/common/response.interceptor.ts` | `{data, meta?, requestId}` 统一封装 |
| `apps/api/src/common/zod.pipe.ts` | zod 校验管道；`VALIDATION_FAILED` + `fieldErrors` |
| `apps/api/src/common/prisma.module.ts` | 配置令牌、Prisma 7 adapter 客户端、`isReady()`、`withTransaction()` |
| `apps/api/src/modules/health/health.controller.ts` | `/health/live`、`/health/ready` |
| `apps/api/src/main.ts` | 启动顺序：配置校验 → 访问日志 → 128KiB JSON 限制 → 全局前缀/过滤器/拦截器 |
| `apps/api/test/pipeline-check.ts` | 12 项真实 HTTP 验收脚本（`pnpm --filter @aiwb/api test:pipeline`） |
| `apps/api/src/common/common.test.ts` | 7 个单元测试（配置、fieldErrors、requestId） |
| `docs/adr/0008-...md` | 显式 `@Inject` 与转换器无关的依赖注入 |

## 2. 验收脚本结果（真实 HTTP）

```
PASS  成功响应带 data 与 requestId，且与响应头一致
PASS  合法外部 requestId 透传
PASS  缺字段返回 422 且 fieldErrors 指向 title
PASS  未知字段 workspaceId 被拒绝
PASS  业务异常映射 412 + currentVersion
PASS  未知异常 500 且不泄露连接串/堆栈
PASS  未知路由 404 NOT_FOUND
PASS  不支持的方法不会落到 500（Nest 映射为 404）
PASS  DB 不可用：ready=503 且不泄露内部信息
PASS  DB 不可用：live=200（只反映进程）
PASS  DB 可用：ready=200 且 checks.database=up
PASS  日志脱敏且保留 requestId

合计 12 项，通过 12，失败 0
```

## 3. 真实进程验证（构建产物 + 真实数据库）

| 步骤 | 结果 |
|---|---|
| `pnpm build` → `node dist/main.js`（API_PORT=3003） | 启动成功，日志输出 `api_started`（含 port/host/env/publicOrigin） |
| `GET /api/v1/health/live` | `200 {"data":{"status":"ok","service":"api","uptimeSeconds":6},"requestId":"r-85bb33ba1480"}`，响应头 `X-Request-Id` 与响应体一致 |
| `GET /api/v1/health/ready`（数据库正常） | `200 {"data":{"status":"ok","checks":{"database":"up"}},"requestId":"r-86357b31213f"}` |
| 停止开发数据库后 `GET /health/ready` | **503**（`SERVICE_UNAVAILABLE`），响应不含主机／连接串 |
| 停止开发数据库后 `GET /health/live` | **200**（进程仍在） |
| 重新启动数据库后 `GET /health/ready` | `200`（自动恢复，无需重启 API） |
| 删除 `DATABASE_URL` 后启动 | 立即失败：`ConfigValidationError ... DATABASE_URL：expected string, received undefined`，退出码 1，未监听端口（fail-fast） |

## 4. F06-01 主流程与交付物

| 检查 | 实际 |
|---|---|
| 非法请求返回一致错误 | 422（字段错误，含 `fieldErrors`）、404（不存在）、503（依赖不可用）均使用 `{error:{code,message,...},requestId}` |
| 数据库不可用时 ready 失败 | 实测 503；错误体只有通用文案与 `SERVICE_UNAVAILABLE` |
| 日志不输出密码与连接密钥 | 日志脱敏用例断言 `password`／`token`／`cookie`／`authorization` 均变为 `[redacted]`，且非敏感字段（email）保留 |

## 5. F06-02 边界／异常

| 检查 | 实际 |
|---|---|
| DB 不可用时 ready 失败而 live 正常 | 503 / 200（同一进程、同一时刻） |
| 错误响应不泄露连接信息 | 未知异常用例断言响应不含 `postgresql://`、`secret`、`stack`；ready 503 断言不含 `postgres`、`127.0.0.1` |
| 恢复后自动转好 | 数据库重启后 ready 自动 200，无需重启 API |
| 请求体大小限制 | `app.useBodyParser('json', { limit: '128kb' })`（契约要求 ≤128KiB；超出由框架返回 413 → `PAYLOAD_TOO_LARGE`） |

## 6. F06-03 隔离与一致性

| 检查 | 实际 |
|---|---|
| 未知输入字段被拒 | `z.strictObject` + 未知键映射到 `fieldErrors.workspaceId`，请求返回 422 |
| 日志仅含脱敏上下文 | 脱敏路径见 ADR／`logger.ts` 的 `REDACT_PATHS`；不记录请求体，只记长度 |
| 可按 requestId 定位 | 访问日志与错误日志都带 `requestId`；响应头 `X-Request-Id` 与响应体 `requestId` 一致；外部合法 ID 透传 |
| 技术细节 | 通过 `AsyncLocalStorage` 传递，无参数穿透；`normalizeRequestId` 拒绝过短或含换行的值，防日志注入 |

## 7. 工程检查

| 检查 | 结果 |
|---|---|
| `pnpm --filter @aiwb/api test`（vitest） | 7/7 通过 |
| `pnpm --filter @aiwb/api test:pipeline`（tsx） | 12/12 通过 |
| `pnpm typecheck` | 退出码 0 |
| `pnpm lint` | 退出码 0（仅 CLI 脚本的 `no-console` 警告） |
| `pnpm build` | 退出码 0 |

## 8. 缺陷与修复

| 编号 | 现象 | 根因 | 修复 |
|---|---|---|---|
| D-F06-01 | 验收脚本中 `HealthController.prisma` 为 `undefined`，`/health/ready` 返回 500 | esbuild/tsx **不生成** `design:paramtypes`，Nest 按类型注入失败 | 全项目改用显式 `@Inject(Token)`；新增 ADR-0008；独立 `tsconfig.test.json` 开启装饰器 |
| D-F06-02 | `prisma.module.ts` 引用路径错误（`../../generated/...`） | 生成目录位于 `src/generated`，从 `src/common` 只需上一级 | 改为 `../generated/prisma/client.js` |
| D-F06-03 | 顶层 `password`／`token` 未被脱敏 | pino 的 `*.password` 只匹配嵌套一层 | `REDACT_PATHS` 增加顶层键 |
| D-F06-04 | 构建产物启动时报缺 `DATABASE_URL` | 只从 cwd 读 `.env`，而从 `apps/api` 启动时 `.env` 在仓库根 | `main.ts` 显式从仓库根加载 `.env`（已存在的环境变量优先） |
| D-F06-05 | `pnpm --filter @aiwb/api test:pipeline` 报装饰器未启用 | tsx 未解析 `extends` 继承的 `experimentalDecorators` | 新增 `apps/api/tsconfig.test.json` 并让脚本显式指定 |

## 9. 未验证项

| 项 | 原因 | 处理 |
|---|---|---|
| 413／415 的真实超限请求 | 未构造 >128KiB 请求体 | F39 集成测试补 |
| 限流（429） | 登录／搜索接口尚未实现 | F09／F22 |
| OpenAPI 文档暴露开关 `ENABLE_API_DOCS` | 未接入 Swagger | F07 之后按需 |
| 日志采集与告警 | 无生产环境 | F49 |

## 10. 结论

F06 的配置校验、错误信封、zod 校验、异常过滤、requestId、脱敏日志、健康检查与事务入口均以真实 HTTP 与真实数据库验证通过（12 项验收 + 7 项单测 + 真实进程 503/200 切换）。**依赖注入改为显式 `@Inject`，是对 esbuild 不生成装饰器元数据的必要修正（ADR-0008）。**
