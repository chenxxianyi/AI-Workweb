# ADR-0008 · 显式 `@Inject` 与转换器无关的依赖注入

- 状态：已接受（F06）
- 日期：2026-11-03
- 关联：R26、R27；ADR-0001（分层）；ADR-0002（工具链）

## 背景

NestJS 默认通过 TypeScript 的 `emitDecoratorMetadata` 生成 `design:paramtypes`，从而按类型注入构造函数参数。但本项目在三个位置使用不同的转换器：

| 场景 | 转换器 | 是否生成 `design:paramtypes` |
|---|---|---|
| 生产/构建 | `tsc` | 是 |
| 开发热重载 | `tsx`（esbuild） | **否**（esbuild 不支持 `emitDecoratorMetadata`） |
| 验收脚本 | `tsx` | **否** |

实测后果：F06 的验收脚本中 `HealthController` 的 `prisma` 为 `undefined`，`/health/ready` 抛 `TypeError` 而不是返回 503。若只依赖类型注入，开发模式出现的行为差异会掩盖真实缺陷。

## 决策

1. **所有构造函数依赖一律写显式 `@Inject(Token)`**，包括类令牌：
   ```ts
   constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}
   ```
2. 不使用 `APP_*` 之外的字符串魔法值；令牌统一从模块导出（`APP_CONFIG`、`PrismaService`）。
3. 仍需 `experimentalDecorators` 支持（esbuild 支持）；`emitDecoratorMetadata` 保留在 tsconfig 中但**不作为正确性依赖**。
4. 验收脚本使用独立的 `apps/api/tsconfig.test.json`（显式开启装饰器），避免 `extends` 在 esbuild 下被忽略。

## 后果

- 每个服务的构造函数多写一个 `@Inject(...)`；换来 tsc / tsx / vitest 三种运行方式行为一致。
- 误删 `@Inject` 时错误在启动时立即暴露（`undefined` 注入），而不是等到某条请求路径。
- 新模块评审清单：构造函数参数是否有显式 `@Inject`。

## 替代方案

| 方案 | 未采用原因 |
|---|---|
| 开发也用 `tsc --watch` + `node --watch` | 多一个进程与产物目录，热重载比 tsx 慢；仍需为测试脚本另建运行方式 |
| 引入 SWC + `@nestjs/swc` 装饰器元数据 | 新增构建链依赖，与 Vite/esbuild 生态不一致 |
| 依赖 `experimentalDecorators` + 类型注入并只在生产用 tsc | 开发/测试与生产不一致，正是本 ADR 要消除的风险 |
