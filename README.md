# AI 编程工作台

个人或小团队私有部署的全栈应用：今日聚焦、项目雷达、知识库、AI 台账四个模块，加登录、空间权限、导入导出、备份与运维。

- 方案：[全栈全流程开发方案](AI编程工作台-全栈全流程开发方案.md)
- 任务与进度：[任务开发文档](全栈开发任务/任务开发文档.md)｜[任务进度](全栈开发任务/任务进度.md)
- 架构与契约：[文档索引](docs/README.md)

## 技术栈（F03 冻结）

Node 22.23.4 · pnpm 11.25.0 · TypeScript 5.9.3 · React 19.3.1 · Vite 8.3.5 · NestJS 12.3.2 · Prisma 7.10.1 · PostgreSQL 17.11 · Vitest 5.1.0 · Playwright 1.64.1。
精确版本与偏差见 [docs/架构与版本矩阵.md](docs/架构与版本矩阵.md)。

## 目录

```text
apps/web        前端（React + Vite）
apps/api        后端（NestJS）；worker 与 api 同镜像、不同启动命令
packages/contracts  前后端共享契约（错误码、响应封装、枚举）
packages/domain     纯业务日期函数（业务日、周/月区间）
database            Prisma schema、审核 SQL 迁移与种子（F05 起）
infra               Dockerfile、Compose、Caddy 模板（F43 起可执行）
scripts             开发脚本（本地数据库等）
docs                ADR、接口契约、数据库约定、运行手册
tests               集成与 E2E（F38 起）
全栈开发任务         任务包、进度与 FS 存档
```

## 快速开始（本机 Windows）

```powershell
# 1) 环境
node --version        # 需要 22.23.4
pnpm --version        # 需要 11.25.0

# 2) 依赖（精确版本，锁文件入库）
pnpm install

# 3) 本地数据库（项目内隔离实例，127.0.0.1:55432，不占用 5432）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/dev-db.ps1 init

# 4) 配置
Copy-Item .env.example .env    # 按本机填写 DATABASE_URL 等

# 5) 构建共享包并启动
pnpm build
pnpm dev              # web: http://127.0.0.1:5173  api: http://127.0.0.1:3001/api/v1
```

> 本机 PowerShell 执行策略为 Restricted，脚本统一用 `-ExecutionPolicy Bypass` **单次调用**，不修改系统策略。

## 常用命令

| 命令 | 作用 |
|---|---|
| `pnpm build` | 构建共享包与两个应用（按依赖拓扑排序） |
| `pnpm typecheck` | 全仓类型检查 |
| `pnpm lint` | ESLint（扁平配置） |
| `pnpm test` | 单元测试（Vitest） |
| `pnpm verify` | typecheck + lint + test + build（提交前自检） |
| `pnpm db:status` / `db:start` / `db:stop` | 本地开发数据库 |
| `pnpm db:generate` | 生成 Prisma Client（`pnpm install` 的 postinstall 也会执行） |
| `pnpm db:migrate` / `db:deploy` | 开发迁移（生成+应用）／按已有迁移部署（CI/生产用） |
| `pnpm db:migrate:status` | 迁移状态 |
| `pnpm db:seed` | 写入演示数据（幂等；不会自动执行） |
| `pnpm db:smoke` | 数据库连通性与关系读冒烟 |
| `pnpm --filter @aiwb/api auth:bootstrap` | 创建首个 Owner 与个人空间（密码走 stdin，不落 shell 历史） |
| `pnpm --filter @aiwb/api auth:recover` | 签发一次性恢复令牌（30 分钟，服务器执行） |
| `pnpm --filter @aiwb/api auth:calibrate` | 实测 Argon2id 单次哈希耗时（校准参数） |
| `pnpm dev` | 并行启动前后端开发服务器 |

## 交付边界（当前阶段）

- 已完成：F01 需求冻结、F02 原型、F03 架构与契约冻结。
- 进行中：F04 仓库与可复现开发环境（本文）。
- 未开始：身份权限、业务模块、导入导出、离线、测试、部署、备份与交接（F05～F52）。
- 未验证：Docker／Compose、生产域名与服务器、备份位置、CI 平台、Safari 实机（见 [docs/项目参数与验收责任.md](docs/项目参数与验收责任.md) 第 3 节）。

## 历史参考

- [原单文件前端方案](AI编程工作台-开发方案.md)：功能与业务参考，其中"无后端、localStorage 为主库"等约束已被全栈方案替代。
- [旧 36 步任务包](AI编程工作台-任务开发文档.md)：历史路线，停止使用。
