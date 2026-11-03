-- F14：移除 projects_archived_after_created_ck
--
-- 原因（实测）：归档时应用侧用 `new Date()` 写入 archived_at，而 created_at 由数据库 now() 生成。
-- 当应用与数据库时钟存在毫秒级差异时，"创建后立即归档"会触发该 CHECK（已实际复现）。
-- 这个约束只防"归档早于创建"这种无实际危害的输入，却引入了时钟依赖的失败模式，
-- 因此移除；归档语义仍由 archived_at IS NULL 判断。
ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_archived_after_created_ck;
