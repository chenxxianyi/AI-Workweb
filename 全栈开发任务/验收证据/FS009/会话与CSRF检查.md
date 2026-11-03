# FS009 验收证据 · F09 实现服务器会话登录退出与CSRF

> 执行日期：2026-11-03（Asia/Shanghai）｜执行人：开发执行人（AI 编码代理）
> 环境：Node 22.23.4 · NestJS 12.3.2 · Prisma 7.10.1 · argon2 0.45.2 · PostgreSQL 17.11（`aiwb_test`）
> 说明：全部用例走真实 HTTP + 真实数据库；脚本会 TRUNCATE，且库名不以 `_test` 结尾时拒绝运行。

## 1. 交付物

| 文件 | 说明 |
|---|---|
| `apps/api/src/modules/auth/session.ts` | Cookie 解析/序列化、令牌生成、SHA-256、常数时间比较（零依赖） |
| `apps/api/src/modules/auth/session.service.ts` | 创建/解析/滑动续期/CSRF 轮换/吊销/列表；Cookie 属性由配置决定 |
| `apps/api/src/modules/auth/session.guard.ts` | 全局会话守卫（默认需登录，`@Public()` 显式开放；区分未登录与过期） |
| `apps/api/src/modules/auth/csrf.guard.ts` | 全局 CSRF 守卫（会话绑定哈希 + 未登录双提交 + Origin/Referer 校验） |
| `apps/api/src/modules/auth/login.ts` | 登录校验（统一失败文案、未知账号也做一次 Argon2、审计、会员列表） |
| `apps/api/src/modules/auth/login-throttle.ts` | 账号级失败锁定（15 分钟 5 次，内存、只存邮箱哈希） |
| `apps/api/src/modules/auth/auth.controller.ts` | `csrf`／`login`／`logout`／`me`／`sessions`（列表、吊销单个、吊销其他）／`password`／`recovery` |
| `apps/api/src/common/rate-limit.ts` | 限流支持从配置读取（登录/搜索限额可由 `.env` 调整） |
| `apps/api/test/session-check.ts` | 36 项真实 HTTP 验收 |
| `apps/api/src/modules/auth/session.test.ts` | 11 项单元测试（Cookie、令牌、锁定） |

## 2. 验收结果（36/36 PASS）

`pnpm --filter @aiwb/api test:session`：

| 分组 | 用例（全部 PASS） |
|---|---|
| CSRF 获取 | `GET /auth/csrf` 返回令牌并下发 Cookie；Cookie 与响应体一致；CSRF Cookie 非 HttpOnly |
| 登录拒绝 | 缺 CSRF 头 → 403；来源不匹配（`Origin: https://evil.example`）→ 403；CSRF 不匹配 → 403 |
| 账号存在性 | 错误密码与不存在账号返回**完全相同**的错误体；失败不下发会话 Cookie |
| 登录成功 | 200；响应含 user/memberships/csrfToken/sessionExpiresAt；不含密码哈希或角色；Cookie 含 HttpOnly + SameSite=Lax、开发环境无 Secure；Cookie 中无角色/密码；CSRF 已轮换 |
| 会话读取 | 无 Cookie → 401 `UNAUTHENTICATED`；有 Cookie → `/auth/me` 返回用户、空间（role=owner）、偏好 theme=system；会话列表标记 current |
| 改密 | 缺 CSRF → 403；CSRF 错误 → 403；正确 → 200 且**当前会话保留**；旧密码失效；新密码可在第二设备登录 |
| 多设备 | 两台设备各一条会话；吊销其他会话成功，被吊销方立即 401；吊销不存在的会话 → 404 |
| 过期与吊销 | 空闲过期 → 401 `SESSION_EXPIRED`；绝对过期 → 401 `SESSION_EXPIRED`；已吊销 → 401 `UNAUTHENTICATED` |
| 重启 | 关闭应用后用同一 Cookie 启动新实例访问 `/auth/me` → **200**（会话未丢） |
| 退出 | `POST /auth/logout` → 200 且 `sfs_session` 下发 `Max-Age=0`；之后 401 |
| 生产 Cookie | `COOKIE_SECURE=true` 时会话 Cookie 同时含 `Secure` 与 `HttpOnly` |
| 登录锁定 | 连续 5 次失败后，**即使密码正确**也返回 429（`details.retryAfterSeconds > 0`） |

## 3. 关键设计取舍

| 取舍 | 原因 |
|---|---|
| 全局守卫 + `@Public()` 白名单，而不是逐路由加守卫 | 漏加守卫会直接暴露接口；默认拒绝更安全 |
| 会话存数据库、每次请求查库 | 可即时吊销（改密/移除成员/退出），重启不丢（F09-01/F09-02） |
| 滑动续期 60 秒节流 | 避免每个请求一次 UPDATE；空闲窗口仍按配置生效 |
| 登录失败也执行一次 Argon2（未知账号用惰性 dummy hash） | 避免用响应耗时区分账号是否存在 |
| 恢复接口 `@CsrfExempt()` | 凭据是一次性令牌而非 Cookie，CSRF 无法带来额外保护；已在 C-15 记录 |
| 登录限额来自 `RATE_LIMIT_LOGIN_PER_MINUTE` | 便于按部署调整；测试中调高以单独验证“账号锁定” |

## 4. 回归

| 检查 | 结果 |
|---|---|
| `pnpm --filter @aiwb/api test`（vitest） | **27/27**（common 7 + password 9 + session 11） |
| `test:pipeline`（F06） | 12/12 |
| `test:auth`（F08 服务层/CLI） | 31/31 |
| `test:auth-http`（F08 HTTP） | 14/14 |
| `pnpm typecheck` / `lint` / `build` | 退出码 0 |

## 5. 缺陷与修复

| 编号 | 现象 | 根因 | 修复 |
|---|---|---|---|
| D-F09-01 | `Request.auth` 类型扩展编译失败（`express-serve-static-core cannot be found`） | pnpm 严格依赖下应用不能直接引用 `@types/express` 的传递依赖做 module augmentation | 改为显式交叉类型 `AuthedRequest` + `setRequestAuth`/`requestAuth`/`requireRequestAuth` 辅助函数 |
| D-F09-02 | 登录限流写死 10 次/分钟，导致“账号锁定”用例无法验证 | 限额无法按环境调整 | `RateLimit` 支持 `{ fromConfig }`，登录读取 `RATE_LIMIT_LOGIN_PER_MINUTE`；测试调高后单独验证锁定 |
| D-F09-03 | 健康检查在加入全局会话守卫后变 401 | 全局默认需登录 | `HealthController` 加 `@Public()`；同时把所有公开路由显式标注 |
| D-F09-04 | PowerShell 字符串替换把 `\n` 写进 `.ts`，导致类型检查报“Invalid character” | 用单引号字符串做多行替换 | 改用编辑工具或双引号 + 反引号换行；已恢复文件 |

## 6. 未验证项

| 项 | 原因 | 处理 |
|---|---|---|
| 浏览器端登录页与“会话过期”对话框 | F11 | F11 用真实接口联调并复验输入保留 |
| 跨站子域攻击（同站不同源） | 无子域环境 | F41 安全加固时复核 Origin 策略与 Caddy 配置 |
| 多实例会话/限流共享 | 单机部署 | F43 按部署形态评估 |
| 代理后的 `req.ip` 可信来源 | 无反向代理 | F43 在 Caddy 后设置 `trust proxy` 并复验限流键 |
| 会话表清理（长期过期数据） | 需要后台任务 | F34（回收站与清理任务）一并实现 |

## 7. 结论

F09 的登录、退出、会话管理、CSRF 与限流在真实 HTTP 与真实数据库上通过 36 项验收；
会话可即时吊销、重启不丢、Cookie 不含角色与密码，跨站写请求与缺失 CSRF 均被拒绝，
生产模式下 Cookie 带 `Secure` + `HttpOnly`。**同时修复了新增全局守卫带来的健康检查 401 回归（D-F09-03）。**
