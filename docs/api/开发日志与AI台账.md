# 开发日志与AI台账接口边界

开发日志使用 `/api/v1/workspaces/{workspaceId}/logs`，与 `/ledger` 的AI使用记录独立存储。早期FS017/FS018将台账误记为开发日志，已补充独立日志并重新验收，旧版本仅作为历史证据保留。

- GET：`date`（可选业务日期）、`limit`（1–100，默认20）、`cursor`；返回 `{logs,hasMore,nextCursor}`。按业务日期、创建时间、ID倒序，游标绑定空间和日期。
- POST：`{text,logDate?}`，文本去首尾空白后1–4000字符；日期缺省取空间时区今日，作者取会话。必须CSRF和Idempotency-Key。
- PATCH `/{id}`：完整 `{text,logDate?}`，必须CSRF、If-Match。
- DELETE `/{id}`：必须CSRF、If-Match，软删除，数据保留供F34回收站恢复。
- Viewer只读；Editor/Owner可写。未知作者字段422，旧版本412，缺版本428，跨空间对象404。写入与审计同事务，审计不保存日志正文。

AI台账 `/ledger` 记录工具、场景、投入分钟、节省分钟、效果评分和可选项目/知识关联。工具/场景按已冻结契约为最多32位小写标识；分钟1–1440，节省0–1440，评分1–5。部分修改同样执行所有合并值与关联归属校验；删除以版本CAS避免覆盖并发编辑。
