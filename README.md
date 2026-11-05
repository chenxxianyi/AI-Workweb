# AI 编程工作台

个人或小团队的本机全栈工作台：今日聚焦、项目雷达、知识库、AI 台账，以及账号权限、导入导出、离线草稿、备份与巡检。Windows原生运行，不需要Docker。

## 立即使用

地址：**http://127.0.0.1:3000**。请使用这个完整地址，localhost和其他主机名不属于当前同源配置。

初始账号：`owner@local.aiwb`。随机初始密码保存在本机受限文件 `.data/runtime/production/credentials.txt`，不写入README、聊天或普通存档。用资源管理器或当前Windows账号打开该文件。正式库没有复制开发/预发布账号。

在项目根目录使用PowerShell 7：

```powershell
pwsh -NoProfile -File scripts/local-workbench.ps1 start
pwsh -NoProfile -File scripts/local-workbench.ps1 status
pwsh -NoProfile -File scripts/local-workbench.ps1 backup
pwsh -NoProfile -File scripts/local-workbench.ps1 stop
```

start启动已有数据库、正式应用和后台巡检；stop停止应用与巡检，共享PostgreSQL仍运行。电脑重启后再次start。已有部署不要重新init、seed或重置数据库；整集群reset已禁用。脚本遵循当前执行策略。

## 文档与验收

- [使用手册](docs/使用手册.md)：四模块、快捷键、权限、冲突和离线边界。
- [本机运维手册](docs/本机运维手册.md)：新环境准备、启停、发布、加密备份、恢复、回退、巡检。
- [开发交接](docs/开发交接.md)：模块、配置、迁移与API维护。
- [发布记录](docs/本机发布记录.md)：最终运行包、实际验收及观察移交。
- [文档索引](docs/README.md)｜[任务进度](全栈开发任务/任务进度.md)｜[每步存档](全栈开发任务/存档规范.md)。

24小时观察按用户确认另行记录。后台每60秒采样，结果位于 `.data/runtime/production/observation.json`；到期生成 `observation-24h.json`。休眠或中断会计入覆盖缺口，不能提前声称通过。告警保存在同目录 `alerts.jsonl`；当前无外部通知渠道。

## 开发与检查

冻结环境：Node22.23.4、pnpm11.25.0、PostgreSQL17.11。React19、Nest12、Prisma7；精确包版本以锁文件及[版本矩阵](docs/架构与版本矩阵.md)为准。

```powershell
pnpm install --frozen-lockfile --prod=false --store-dir D:\.pnpm-store
pnpm db:generate
pnpm verify
pnpm test:integration
pnpm dev
```

开发web为5173、API为3001；预发布3003、正式3000。集成测试只允许本机独立`*_test`库，会清理测试数据。开发与正式环境使用独立库/角色/Cookie/传输目录。`.env`仅包含本机管理与开发/测试配置；正式应用使用受限runtime配置。不要把DATABASE_URL_TEST指向真实业务库。

正式发布走 `node scripts/local-ci.mjs <证据目录> --release=<新版本>`，通过后再按运维手册部署同一个包。不要运行开发服务器来代替正式发布。

## 目录

| 路径 | 内容 |
|---|---|
| apps/web | React页面、请求层、私有缓存与草稿 |
| apps/api | Nest API、事务、角色、租约worker、CLI |
| packages/domain、contracts | 日期规则和共享契约 |
| database | Prisma模型、5个审核迁移、历史迁移hash基线 |
| scripts | 本机流水线、运行包、启停、备份恢复、巡检和存档 |
| .data/releases | 不可覆盖的正式运行包，固定依赖/构建/迁移/SBOM/manifest |
| .data/runtime | 按环境隔离的配置、凭据、日志、巡检记录 |
| 全栈开发任务 | 任务文档、进度、验收证据和FS快照 |

## 交付边界（当前阶段）

- 部署方式：本机Node.js + PostgreSQL，正式构建与原生启停，不使用Docker（ADR-0009）。
- 已完成并归档：52/52步；最新为F52 冻结本机验收版本并完成全流程归档。
- 下一任务：本机交付已完成。
- Safari实机、异机灾备、公网环境和外部CI为后续扩展，不冒充已经验证。
- 具体证据与每步快照见[任务进度](全栈开发任务/任务进度.md)。
## 历史参考

原始[全栈方案](AI编程工作台-全栈全流程开发方案.md)保留；与本机部署冲突的部分以ADR-0009、ADR-0011和当前运维手册为准。原前端方案与旧36步任务包是历史参考。F43文件名保留原Compose名称以保持链接，但任务内容已改为原生部署。
