-- F05 审核 SQL 迁移：Prisma schema 无法表达的约束、空间一致性触发器与索引
-- 依据：docs/数据库实现约定.md 第 3、4、5 节
--
-- 为什么用触发器而不是复合外键：
--   设计文档要求「workspace_id 参与的复合外键，数据库拒绝跨空间串联」。
--   Prisma Migrate 无法表达复合外键，若用 ALTER TABLE 添加，后续 `migrate dev`
--   会把它们判定为「schema 中不存在的 FK」并生成 DROP 语句（已实测，见 FS005 记录）。
--   因此改用触发器实现同一不变式：Prisma 不内省触发器，迁移不会误删；
--   RAISE ... USING ERRCODE='23503' 保持与外部键冲突相同的错误码语义。
--   自动化检查见 database/tests/constraints-check.sql。

-- ---------------------------------------------------------------------------
-- 1. 空间一致性触发器：子记录的 workspace_id 必须与父记录一致，且父记录存在
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION assert_same_workspace() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  parent_workspace uuid;
  parent_id uuid;
  parent_table text;
  child_column text;
BEGIN
  IF TG_TABLE_NAME = 'tasks' OR TG_TABLE_NAME = 'entries' THEN
    parent_table := 'projects'; child_column := 'project_id';
  ELSIF TG_TABLE_NAME = 'ledger_records' THEN
    -- 两个父引用，分别校验
    parent_id := NEW.project_id;
    IF parent_id IS NOT NULL THEN
      SELECT workspace_id INTO parent_workspace FROM projects WHERE id = parent_id;
      IF parent_workspace IS NULL OR parent_workspace <> NEW.workspace_id THEN
        RAISE EXCEPTION '跨空间引用：ledger_records.project_id 不属于当前空间'
          USING ERRCODE = '23503', CONSTRAINT = 'ledger_project_ws_ck';
      END IF;
    END IF;
    parent_id := NEW.entry_id;
    IF parent_id IS NOT NULL THEN
      SELECT workspace_id INTO parent_workspace FROM entries WHERE id = parent_id;
      IF parent_workspace IS NULL OR parent_workspace <> NEW.workspace_id THEN
        RAISE EXCEPTION '跨空间引用：ledger_records.entry_id 不属于当前空间'
          USING ERRCODE = '23503', CONSTRAINT = 'ledger_entry_ws_ck';
      END IF;
    END IF;
    RETURN NEW;
  ELSIF TG_TABLE_NAME = 'entry_revisions' OR TG_TABLE_NAME = 'entry_usage' THEN
    parent_table := 'entries'; child_column := 'entry_id';
  ELSIF TG_TABLE_NAME = 'entry_tags' THEN
    parent_id := NEW.entry_id;
    SELECT workspace_id INTO parent_workspace FROM entries WHERE id = parent_id;
    IF parent_workspace IS NULL OR parent_workspace <> NEW.workspace_id THEN
      RAISE EXCEPTION '跨空间引用：entry_tags.entry_id 不属于当前空间'
        USING ERRCODE = '23503', CONSTRAINT = 'entry_tags_entry_ws_ck';
    END IF;
    parent_id := NEW.tag_id;
    SELECT workspace_id INTO parent_workspace FROM tags WHERE id = parent_id;
    IF parent_workspace IS NULL OR parent_workspace <> NEW.workspace_id THEN
      RAISE EXCEPTION '跨空间引用：entry_tags.tag_id 不属于当前空间'
        USING ERRCODE = '23503', CONSTRAINT = 'entry_tags_tag_ws_ck';
    END IF;
    RETURN NEW;
  ELSIF TG_TABLE_NAME = 'task_entries' THEN
    parent_id := NEW.task_id;
    SELECT workspace_id INTO parent_workspace FROM tasks WHERE id = parent_id;
    IF parent_workspace IS NULL OR parent_workspace <> NEW.workspace_id THEN
      RAISE EXCEPTION '跨空间引用：task_entries.task_id 不属于当前空间'
        USING ERRCODE = '23503', CONSTRAINT = 'task_entries_task_ws_ck';
    END IF;
    parent_id := NEW.entry_id;
    SELECT workspace_id INTO parent_workspace FROM entries WHERE id = parent_id;
    IF parent_workspace IS NULL OR parent_workspace <> NEW.workspace_id THEN
      RAISE EXCEPTION '跨空间引用：task_entries.entry_id 不属于当前空间'
        USING ERRCODE = '23503', CONSTRAINT = 'task_entries_entry_ws_ck';
    END IF;
    RETURN NEW;
  ELSE
    RAISE EXCEPTION 'assert_same_workspace 未覆盖表 %', TG_TABLE_NAME;
  END IF;

  IF child_column = 'project_id' THEN
    parent_id := NEW.project_id;
  ELSE
    parent_id := NEW.entry_id;
  END IF;

  IF parent_id IS NULL THEN
    RETURN NEW;
  END IF;

  EXECUTE format('SELECT workspace_id FROM %I WHERE id = $1', parent_table)
    INTO parent_workspace USING parent_id;

  IF parent_workspace IS NULL OR parent_workspace <> NEW.workspace_id THEN
    RAISE EXCEPTION '跨空间引用：%.% 不属于当前空间', TG_TABLE_NAME, child_column
      USING ERRCODE = '23503', CONSTRAINT = TG_TABLE_NAME || '_ws_ck';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER tasks_same_workspace_trg
  BEFORE INSERT OR UPDATE OF workspace_id, project_id ON tasks
  FOR EACH ROW EXECUTE FUNCTION assert_same_workspace();

CREATE TRIGGER entries_same_workspace_trg
  BEFORE INSERT OR UPDATE OF workspace_id, project_id ON entries
  FOR EACH ROW EXECUTE FUNCTION assert_same_workspace();

CREATE TRIGGER ledger_records_same_workspace_trg
  BEFORE INSERT OR UPDATE OF workspace_id, project_id, entry_id ON ledger_records
  FOR EACH ROW EXECUTE FUNCTION assert_same_workspace();

CREATE TRIGGER entry_revisions_same_workspace_trg
  BEFORE INSERT OR UPDATE OF workspace_id, entry_id ON entry_revisions
  FOR EACH ROW EXECUTE FUNCTION assert_same_workspace();

CREATE TRIGGER entry_usage_same_workspace_trg
  BEFORE INSERT OR UPDATE OF workspace_id, entry_id ON entry_usage
  FOR EACH ROW EXECUTE FUNCTION assert_same_workspace();

CREATE TRIGGER entry_tags_same_workspace_trg
  BEFORE INSERT OR UPDATE OF workspace_id, entry_id, tag_id ON entry_tags
  FOR EACH ROW EXECUTE FUNCTION assert_same_workspace();

CREATE TRIGGER task_entries_same_workspace_trg
  BEFORE INSERT OR UPDATE OF workspace_id, task_id, entry_id ON task_entries
  FOR EACH ROW EXECUTE FUNCTION assert_same_workspace();

-- ---------------------------------------------------------------------------
-- 2. CHECK 约束：字段长度、数值范围、状态与 done_at 一致性
-- ---------------------------------------------------------------------------

ALTER TABLE projects
  ADD CONSTRAINT projects_name_len_ck CHECK (char_length(name) BETWEEN 1 AND 100),
  ADD CONSTRAINT projects_next_step_len_ck CHECK (char_length(next_step) BETWEEN 0 AND 300),
  ADD CONSTRAINT projects_manual_progress_ck CHECK (manual_progress IS NULL OR manual_progress BETWEEN 0 AND 100),
  ADD CONSTRAINT projects_manual_mode_ck CHECK (progress_manual OR manual_progress IS NULL);

ALTER TABLE tasks
  ADD CONSTRAINT tasks_title_len_ck CHECK (char_length(title) BETWEEN 1 AND 200),
  ADD CONSTRAINT tasks_done_at_ck CHECK ((status = 'done') = (done_at IS NOT NULL));

ALTER TABLE development_logs
  ADD CONSTRAINT development_logs_text_len_ck CHECK (char_length(text) BETWEEN 1 AND 4000);

ALTER TABLE entries
  ADD CONSTRAINT entries_title_len_ck CHECK (char_length(title) BETWEEN 1 AND 200),
  ADD CONSTRAINT entries_summary_len_ck CHECK (summary IS NULL OR char_length(summary) <= 300),
  ADD CONSTRAINT entries_body_bytes_ck CHECK (octet_length(body) <= 20480),
  ADD CONSTRAINT entries_verified_complete_ck CHECK (
    status <> 'verified'
    OR (
      char_length(btrim(title)) > 0
      AND char_length(btrim(coalesce(summary, ''))) > 0
      AND char_length(btrim(body)) > 0
    )
  );

ALTER TABLE entry_usage
  ADD CONSTRAINT entry_usage_count_ck CHECK (use_count >= 0);

ALTER TABLE ledger_records
  ADD CONSTRAINT ledger_minutes_ck CHECK (minutes > 0),
  ADD CONSTRAINT ledger_saved_minutes_ck CHECK (saved_minutes >= 0),
  ADD CONSTRAINT ledger_effect_ck CHECK (effect BETWEEN 1 AND 5),
  ADD CONSTRAINT ledger_note_len_ck CHECK (note IS NULL OR char_length(note) <= 4000);

ALTER TABLE tags
  ADD CONSTRAINT tags_name_len_ck CHECK (char_length(display_name) BETWEEN 1 AND 32);

ALTER TABLE workspaces
  ADD CONSTRAINT workspaces_timezone_ck CHECK (char_length(timezone) BETWEEN 1 AND 64);

ALTER TABLE users
  ADD CONSTRAINT users_email_normalized_ck CHECK (email_normalized = lower(email_normalized));

-- ---------------------------------------------------------------------------
-- 3. 补充索引（不重复 Prisma 已建的索引；只补部分索引）
-- ---------------------------------------------------------------------------

-- 紧急聚合：未完成的待办按截止日（R06）
CREATE INDEX tasks_ws_due_active_idx
  ON tasks (workspace_id, due_date)
  WHERE deleted_at IS NULL AND status <> 'done';

-- 回收站查询：按删除时间倒序
CREATE INDEX entries_ws_deleted_idx ON entries (workspace_id, deleted_at DESC) WHERE deleted_at IS NOT NULL;
CREATE INDEX tasks_ws_deleted_idx ON tasks (workspace_id, deleted_at DESC) WHERE deleted_at IS NOT NULL;
