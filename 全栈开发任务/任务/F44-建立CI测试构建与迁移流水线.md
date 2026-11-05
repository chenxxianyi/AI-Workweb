# F44 · 建立本机测试构建与迁移流水线

ADR-0009将外部CI/镜像替换为本机 `node scripts/local-ci.mjs <证据目录> --release=<新版本>`。脚本先撤销旧候选，顺序执行工具链、历史迁移hash、类型/lint/单元/构建、新建独立 *_test 空库和非空升级、24套件真实DB、安全扫描/依赖审计，最后生成独立运行包和候选。

任一失败不得生成 `.data/candidate.json`；故意失败参数 `--probe-failure` 用于验收该门禁。每次新建CI库，不使用开发、预发布或正式库。测试不并行争用同一个测试库。数据库迁移独立于应用启动。版本与包清单、CycloneDX依赖清单在运行包中，最终以manifest核验。

验收证据 FS044，实际结论见FS044记录。历史迁移基线 `database/migration-baseline.json` 不得随意改写。新增迁移追加；更换历史基线必须说明原因并重新审查。

执行需要本机Node22、pnpm11、PG17和本机数据库管理连接；pnpm存储通过PNPM_STORE_DIR指定。配置/凭据与普通证据分开。不使用外部CI、Docker或第三方告警。
