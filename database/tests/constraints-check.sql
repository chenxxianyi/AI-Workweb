-- F05 数据库约束负向检查（真实 PostgreSQL，运行在事务内并回滚）
-- 用法：psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f database/tests/constraints-check.sql
-- 期望：全部 PASS；任何 FAIL 都要在 FS005 记录为未通过。

BEGIN;

CREATE OR REPLACE FUNCTION pg_temp.expect_sqlstate(stmt text, expected text, label text)
RETURNS text AS $$
DECLARE
  actual text;
BEGIN
  BEGIN
    EXECUTE stmt;
  EXCEPTION WHEN others THEN
    GET STACKED DIAGNOSTICS actual = RETURNED_SQLSTATE;
    IF actual = expected THEN
      RETURN 'PASS  ' || label || '  (' || actual || ')';
    END IF;
    RETURN 'FAIL  ' || label || '  期望 ' || expected || '，实际 ' || actual;
  END;
  RETURN 'FAIL  ' || label || '  期望报错 ' || expected || '，但语句成功执行';
END;
$$ LANGUAGE plpgsql;

CREATE TEMP TABLE results (line text);
INSERT INTO results
SELECT pg_temp.expect_sqlstate($sql$SELECT 1$sql$, '00000', 'sanity 正向语句') WHERE false;

-- ---------------------------------------------------------------- 预备数据
INSERT INTO users (id, email_normalized, display_name, password_hash)
VALUES ('00000000-0000-0000-0000-000000000001', 'owner@example.test', 'Owner', 'x');

INSERT INTO workspaces (id, name, timezone, created_by) VALUES
  ('00000000-0000-0000-0000-0000000000a1', 'WS-A', 'Asia/Shanghai', '00000000-0000-0000-0000-000000000001'),
  ('00000000-0000-0000-0000-0000000000b1', 'WS-B', 'Asia/Shanghai', '00000000-0000-0000-0000-000000000001');

INSERT INTO projects (id, workspace_id, name, next_step, created_by)
VALUES ('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a1', '项目A', '下一步', '00000000-0000-0000-0000-000000000001');

INSERT INTO tasks (id, workspace_id, title, created_by)
VALUES ('00000000-0000-0000-0000-0000000000a3', '00000000-0000-0000-0000-0000000000a1', '任务A', '00000000-0000-0000-0000-000000000001');

INSERT INTO entries (id, workspace_id, title, body, created_by)
VALUES ('00000000-0000-0000-0000-0000000000a4', '00000000-0000-0000-0000-0000000000a1', '知识A', '正文', '00000000-0000-0000-0000-000000000001');

INSERT INTO tags (id, workspace_id, name_normalized, display_name)
VALUES ('00000000-0000-0000-0000-0000000000a5', '00000000-0000-0000-0000-0000000000a1', 'tag-a', 'Tag A');

-- ---------------------------------------------------------------- CHECK 约束
INSERT INTO results SELECT pg_temp.expect_sqlstate(
  $sql$INSERT INTO tasks (workspace_id, title, created_by) VALUES ('00000000-0000-0000-0000-0000000000a1', '', '00000000-0000-0000-0000-000000000001')$sql$,
  '23514', '任务标题为空被拒绝');

INSERT INTO results SELECT pg_temp.expect_sqlstate(
  $sql$INSERT INTO tasks (workspace_id, title, status, created_by) VALUES ('00000000-0000-0000-0000-0000000000a1', '完成任务', 'done', '00000000-0000-0000-0000-000000000001')$sql$,
  '23514', 'done 但 done_at 为空被拒绝');

INSERT INTO results SELECT pg_temp.expect_sqlstate(
  $sql$INSERT INTO entries (workspace_id, title, summary, body, status, created_by) VALUES ('00000000-0000-0000-0000-0000000000a1', '缺摘要', '', '正文', 'verified', '00000000-0000-0000-0000-000000000001')$sql$,
  '23514', 'verified 缺摘要被拒绝');

INSERT INTO results SELECT pg_temp.expect_sqlstate(
  format($sql$INSERT INTO entries (workspace_id, title, summary, body, status, created_by) VALUES ('00000000-0000-0000-0000-0000000000a1', '超长正文', '摘要', repeat('a', 20481), 'draft', '00000000-0000-0000-0000-000000000001')$sql$),
  '23514', '正文超过 20480 字节被拒绝');

INSERT INTO results SELECT pg_temp.expect_sqlstate(
  $sql$INSERT INTO ledger_records (workspace_id, record_date, tool, scene, minutes, saved_minutes, effect, created_by) VALUES ('00000000-0000-0000-0000-0000000000a1', current_date, 'claude', 'coding', 0, 10, 3, '00000000-0000-0000-0000-000000000001')$sql$,
  '23514', '台账 minutes=0 被拒绝');

INSERT INTO results SELECT pg_temp.expect_sqlstate(
  $sql$INSERT INTO ledger_records (workspace_id, record_date, tool, scene, minutes, saved_minutes, effect, created_by) VALUES ('00000000-0000-0000-0000-0000000000a1', current_date, 'claude', 'coding', 30, 10, 6, '00000000-0000-0000-0000-000000000001')$sql$,
  '23514', '台账 effect=6 被拒绝');

INSERT INTO results SELECT pg_temp.expect_sqlstate(
  $sql$INSERT INTO projects (workspace_id, name, next_step, progress_manual, manual_progress, created_by) VALUES ('00000000-0000-0000-0000-0000000000a1', '手动进度未启用', '下一步', false, 50, '00000000-0000-0000-0000-000000000001')$sql$,
  '23514', '未启用手动进度却写 manual_progress 被拒绝');

-- ---------------------------------------------------------------- 唯一约束
INSERT INTO results SELECT pg_temp.expect_sqlstate(
  $sql$INSERT INTO tags (workspace_id, name_normalized, display_name) VALUES ('00000000-0000-0000-0000-0000000000a1', 'tag-a', 'Tag A 重复')$sql$,
  '23505', '同空间标签重名被拒绝');

-- ---------------------------------------------------------------- 复合外键（跨空间）
INSERT INTO results SELECT pg_temp.expect_sqlstate(
  $sql$INSERT INTO tasks (workspace_id, project_id, title, created_by) VALUES ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000a2', '跨空间任务', '00000000-0000-0000-0000-000000000001')$sql$,
  '23503', '任务引用其他空间项目被拒绝');

INSERT INTO results SELECT pg_temp.expect_sqlstate(
  $sql$INSERT INTO task_entries (workspace_id, task_id, entry_id) VALUES ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000a3', '00000000-0000-0000-0000-0000000000a4')$sql$,
  '23503', '任务-知识关联跨空间被拒绝');

INSERT INTO results SELECT pg_temp.expect_sqlstate(
  $sql$INSERT INTO entry_tags (workspace_id, entry_id, tag_id) VALUES ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000a4', '00000000-0000-0000-0000-0000000000a5')$sql$,
  '23503', '知识-标签关联跨空间被拒绝');

-- ---------------------------------------------------------------- 正向：同空间可写入
INSERT INTO task_entries (workspace_id, task_id, entry_id)
VALUES ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a3', '00000000-0000-0000-0000-0000000000a4');
INSERT INTO results VALUES ('PASS  同空间任务-知识关联可写入  (00000)');

INSERT INTO entries (workspace_id, title, summary, body, status, created_by)
VALUES ('00000000-0000-0000-0000-0000000000a1', '完整知识', '摘要', '正文', 'verified', '00000000-0000-0000-0000-000000000001');
INSERT INTO results VALUES ('PASS  verified 字段完整时可写入  (00000)');

-- ---------------------------------------------------------------- 汇总
SELECT line FROM results ORDER BY line;
SELECT 'FAILED=' || count(*) AS summary FROM results WHERE line LIKE 'FAIL%';

ROLLBACK;
