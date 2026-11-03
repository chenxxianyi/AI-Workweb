-- F19：草稿允许空标题
--
-- 背景：需求允许“先记一条空草稿，稍后补标题/摘要/正文”，
-- 但 F05 的 entries_title_len_ck 要求 title 至少 1 个字符，导致空壳草稿无法保存。
-- 完整性由 entries_verified_complete_ck 在 status='verified' 时保证，
-- 因此这里只把“长度上限”保留，去掉“至少 1 个字符”的下限。
ALTER TABLE entries DROP CONSTRAINT entries_title_len_ck;
ALTER TABLE entries
  ADD CONSTRAINT entries_title_len_ck CHECK (char_length(title) <= 200);
