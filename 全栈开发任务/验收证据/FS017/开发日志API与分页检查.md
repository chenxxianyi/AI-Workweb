# FS017 验收证据 · F17 实现开发日志API与分页

> 执行日期：2026-11-03（Asia/Shanghai）｜执行人：开发执行人（AI 编码代理）
> 环境：Node 22.23.4 · NestJS 12.3.2 · Prisma 7.10.1 · PostgreSQL 17.11（`aiwb_test`）

## 1. 交付物

| 文件 | 说明 |
|---|---|
| `apps/api/src/modules/ledger/ledger.service.ts` | 列表（筛选+游标指纹）、详情、创建（幂等）、更新/删除（If-Match）、汇总（条数/投入/节省/平均效果/按工具） |
| `apps/api/src/modules/ledger/ledger.controller.ts` | `/workspaces/{w}/ledger`、`/summary`、`/{id}`；创建需 `Idempotency-Key` |
| `apps/api/src/modules/ledger/ledger.module.ts` | 模块注册（依赖 ProjectModule） |
| `apps/api/src/common/prisma-adapter.ts` | **统一 UTC 适配器**（修复时间戳读回偏移，见第 5 节） |
| `apps/api/test/ledger-check.ts` | 32 项真实 HTTP 验收 |
| `docs/api/契约冻结决定.md` | 新增 C-20（日志）与 C-21（时间戳修正） |

## 2. 验收结果（32/32 PASS）

`pnpm --filter @aiwb/api test:ledger`：

| 分组 | 用例（全部 PASS） |
|---|---|
| 创建与作者 | 201 且 `authorId` 为当前用户；`savedMinutes` 显式值生效 |
| 幂等 | 同键重试返回首次结果且记录数不变（1 条）；再次用旧键重试记录数仍不变 |
| 同内容不同操作 | 不同幂等键 → 各自保存（2 条） |
| 伪造作者 | 请求体带 `authorId` → 422 且不落库 |
| 校验 | `minutes=0`、`effect=6`、未来日期、`2026-02-30`、`tool='Claude Code'` 全部 422 |
| 权限 | Viewer 创建 → 403；Viewer 可读 |
| 筛选 | 按项目、按工具、按日期区间（3 条）均正确 |
| 分页 | `limit=2` 返回 2 条 + `hasMore`；第二页与第一页不重复 |
| 游标 | **旧游标换筛选条件 → 400 MALFORMED_REQUEST** |
| 更新 | 缺 If-Match → 428；过期 → 412 + `currentVersion`；正确版本 → 200 且版本 +1 |
| 汇总 | 条数/总分钟正确、按工具分组 ≥2、区间筛选（今日 2 条）正确 |
| 删除与隔离 | 软删除 200、详情 404；另一空间列表为空、跨空间详情 404 |
| 活动 | 记录日志后项目 `last_activity_at` 变大 |

## 3. 关键设计取舍

| 取舍 | 原因 |
|---|---|
| 作者不从请求体读取 | 让“伪造作者”在类型层就不可能，而不是靠运行时判断 |
| 同内容不同键允许并存 | 真实场景里同一投入可能分两次记录；“相同内容”不是幂等依据，键才是 |
| 游标带筛选指纹 | 翻页期间换筛选条件会导致结果错乱，明确报错比静默返回错误页更好 |
| `savedMinutes` 缺省等于 `minutes` | 与需求“节省默认等于投入”一致，同时允许显式覆盖 |
| 汇总单独接口 | 列表分页与统计聚合的查询模式不同，避免列表为统计付出额外成本 |

## 4. 界面影响

本步只做后端；「AI 台账」页面（F26）与项目详情台账块后续接入。项目详情当前已显示台账摘要（F12 聚合接口），本步接口与其字段一致。

## 5. 附带修复：时间戳读回偏移 8 小时（重要）

### 现象

F15 的回归用例 `紧急-停滞列表只有 1 条且天数 ≥4` 在本轮开始稳定失败：`stalledDays` 变成 `null`。

排查发现数据库里 `updated_at = now() - interval '4 days'`，Prisma 读回却是 `2026-10-30T16:03Z`，而真实值是 `2026-10-30T08:03Z`。

### 根因

`@prisma/adapter-pg` 读取 `timestamptz` 时丢掉了 `+08` 偏移，把会话时区下的本地时刻当成 UTC。实测：

```
jsNow      2026-11-03T08:04:46.556Z
adapterNow 2026-11-03T16:04:46.552Z   ← 晚 8 小时
pgText     2026-11-03 16:04:46.552779+08
```

### 影响面

所有基于**时刻**的判断都会被推迟 8 小时：会话过期、`done_at` 的“今日完成”边界、`last_activity_at` 的“几天未活动”、幂等记录过期。之前的用例大多是相对比较或按日期比较，所以没有暴露；F15 的停滞用例恰好在 16:00 之后运行，偏移跨过午夜才暴露出来——属于**会随一天中的时间随机出现的定时炸弹**。

### 处理

新增 `createPrismaAdapter()`，连接固定 `options: '-c timezone=UTC'`；Postgres 以 `+00` 输出，适配器解析即正确。API、CLI、种子与全部集成测试统一改用它。业务日的“空间时区”语义仍由应用层 `businessDate()` 显式计算，不受影响。

### 复验

- 探针：`deltaMinutes` 从 **480 → 0**
- `test:dashboard` 22/22、`test:ledger` 32/32、`test:task` 30/30、`test:project` 32/32、`test:session` 36/36、`test:workspace` 27/27、`test:auth` 31/31、`test:auth-http` 14/14、`vitest` 27/27

## 6. 缺陷与修复

| 编号 | 现象 | 根因 | 修复 |
|---|---|---|---|
| D-F17-01 | 时间戳读回晚 8 小时，F15 停滞用例在 16:00 后失败 | pg 适配器丢弃 timestamptz 偏移（会话时区 Asia/Shanghai） | 统一 UTC 适配器 + 全量回归 |
| D-F17-02 | 用例把 400 写成 422 | `MALFORMED_REQUEST` 的语义是 400 | 修正断言为 400；契约文档同步写明 |
| D-F17-03 | 用 PowerShell 改 TS 代码时 `${...}` 被当作变量展开 | PowerShell 双引号字符串会插值 | 改用 edit 工具修改代码文件 |

## 7. 未验证项

| 项 | 原因 | 处理 |
|---|---|---|
| 台账页面与图表 | F26 | F26 接真实接口 |
| 日志与知识条目关联的界面 | F20/F26 | 接口已支持 `entryId`，界面后续接入 |
| 导出 CSV | F29 | F29 |
| 大批量分页性能 | 数据量小 | F41 |

## 8. 结论

F17 的开发日志接口通过 32 项验收：作者不可伪造、幂等重试只保存一条、同内容不同操作可并存、跨空间不可见、游标不跨筛选复用（400）。同时发现并修复了一个影响全局的时刻读取偏移问题（D-F17-01），使所有既有回归重新转绿。
