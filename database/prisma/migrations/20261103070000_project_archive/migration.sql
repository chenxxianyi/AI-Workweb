-- F12：项目归档字段与查询索引
-- 设计文档只写“项目优先使用归档而非删除”，未给字段；归档用独立时间戳表达，与软删除（回收站）区分。

ALTER TABLE projects ADD COLUMN archived_at timestamptz(3);

-- 进行中项目：未删除、未归档，按最近活动排序
CREATE INDEX projects_ws_active_idx
  ON projects (workspace_id, last_activity_at DESC, id DESC)
  WHERE deleted_at IS NULL AND archived_at IS NULL;

-- 归档列表
CREATE INDEX projects_ws_archived_idx
  ON projects (workspace_id, archived_at DESC)
  WHERE deleted_at IS NULL AND archived_at IS NOT NULL;

ALTER TABLE projects
  ADD CONSTRAINT projects_archived_after_created_ck
  CHECK (archived_at IS NULL OR archived_at >= created_at);
