import { useEffect, useMemo, useRef, useState } from 'react';
import { exportLocal, loadDraft, saveDraft, type LocalDraft } from '../../offline/queue';
import { useRefreshGuard } from '../../offline/refresh-guard';
import {useDraftFlush} from '../../offline/draft-flush';
import { ApiError } from '../../services/api-client';
import { describeApiError } from '../../services/auth-api';
import type { Entry, EntryInput, EntryType } from '../../services/kb-api';
import { BODY_LIMIT_BYTES, TYPE_OPTIONS, formatBytes, isSaveShortcut, utf8Bytes } from './kb-utils';
import styles from './kb.module.css';

interface EntryEditorProps {
  conflict?: Entry | null;
  localScope?: { userId: string; workspaceId: string };
  mode: 'create' | 'edit';
  initial?: Entry;
  submitting: boolean;
  error: unknown;
  onSubmit: (input: EntryInput, baseVersion?: number) => void;
  onCancel: () => void;
}

/**
 * 知识条目编辑器（F20）。
 *
 * - 正文按 UTF-8 字节计数，与服务端 20480 字节上限一致（中文 3 字节）
 * - Ctrl/Cmd+Enter 保存；单独 Enter 只换行（写长文不误触）
 * - 超限时禁止保存并明确提示；服务端失败保留全部输入
 */
export function EntryEditor({
  conflict,
  localScope,
  mode,
  initial,
  submitting,
  error,
  onSubmit,
  onCancel,
}: EntryEditorProps): React.JSX.Element {
  const [title, setTitle] = useState(initial?.title ?? '');
  const [summary, setSummary] = useState(initial?.summary ?? '');
  const [type, setType] = useState<EntryType>(initial?.type ?? 'note');
  const [tags, setTags] = useState((initial?.tags ?? []).join(', '));
  const [body, setBody] = useState(initial?.body ?? '');
  const [baseVersion, setBaseVersion] = useState(initial?.version);
  const [localError, setLocalError] = useState<string | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);
  const [restorable, setRestorable] = useState<LocalDraft | null>(null),
    [draftMessage, setDraftMessage] = useState('');
  const draftName = 'entry:' + (initial?.id ?? 'new');
  useEffect(() => {
    let active = true;
    if (localScope)
      void loadDraft(localScope.userId, localScope.workspaceId, draftName)
        .then((row) => {
          if (active && row) setRestorable(row);
        })
        .catch(() => setDraftMessage('本机草稿不可用，请导出当前输入。'));
    return () => {
      active = false;
    };
  }, [localScope?.userId, localScope?.workspaceId, draftName]);
  const dirty =
    title !== (initial?.title ?? '') ||
    summary !== (initial?.summary ?? '') ||
    type !== (initial?.type ?? 'note') ||
    tags !== (initial?.tags ?? []).join(', ') ||
    body !== (initial?.body ?? '');
  useRefreshGuard(dirty);
  useDraftFlush(dirty&&!!localScope,()=>localScope?saveDraft(localScope.userId,localScope.workspaceId,draftName,{title,summary,type,tags,body},baseVersion):Promise.resolve());
  useEffect(() => {
    if (!dirty || !localScope) return;
    let active = true;
    const timer = setTimeout(() => {
      void saveDraft(
        localScope.userId,
        localScope.workspaceId,
        draftName,
        { title, summary, type, tags, body },
        baseVersion,
      )
        .then(() => {
          if (active) setDraftMessage('已保留本机草稿，尚未保存到服务器。');
        })
        .catch(() => {
          if (active) setDraftMessage('本机存储已满或不可用；输入仍在，请立即导出。');
        });
    }, 200);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [
    title,
    summary,
    type,
    tags,
    body,
    dirty,
    localScope?.userId,
    localScope?.workspaceId,
    draftName,
    baseVersion,
  ]);

  const bytes = useMemo(() => utf8Bytes(body), [body]);
  const overLimit = bytes > BODY_LIMIT_BYTES;

  const fieldErrors =
    error instanceof ApiError && error.fieldErrors !== undefined
      ? Object.entries(error.fieldErrors).map(
          ([field, messages]) => `${field}：${messages.join('、')}`,
        )
      : [];

  const submit = (version = baseVersion): void => {
    setLocalError(null);
    if (overLimit) {
      setLocalError(
        `正文 ${formatBytes(bytes)} 超过 ${formatBytes(BODY_LIMIT_BYTES)} 上限，请精简后再保存`,
      );
      return;
    }
    if (mode === 'create' && title.trim() === '' && body.trim() === '') {
      setLocalError('至少填写标题或正文');
      return;
    }
    onSubmit(
      {
        type,
        title: title.trim(),
        summary: summary.trim() === '' ? null : summary.trim(),
        body,
        tags: tags
          .split(/[,，]/)
          .map((tag) => tag.trim())
          .filter((tag) => tag !== ''),
      },
      version,
    );
  };

  const onBodyKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (isSaveShortcut({ key: event.key, ctrlKey: event.ctrlKey, metaKey: event.metaKey })) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <form
      className={styles.editor}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      noValidate
    >
      {conflict ? (
        <section aria-label="版本冲突比较" role="alert">
          <h3>
            服务器已更新到版本 {conflict.version}，本地原版本 {baseVersion}
          </h3>
          <p>本地输入保留在下方编辑框。请比较服务器内容，再修改本地输入并明确提交合并。</p>
          <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
            {JSON.stringify(
              {
                title: conflict.title,
                summary: conflict.summary,
                type: conflict.type,
                tags: conflict.tags,
                body: conflict.body,
              },
              null,
              2,
            )}
          </pre>
          <button
            type="button"
            onClick={() => {
              setTitle(conflict.title);
              setSummary(conflict.summary ?? '');
              setType(conflict.type);
              setTags(conflict.tags.join(', '));
              setBody(conflict.body);
              setBaseVersion(conflict.version);
            }}
          >
            放弃本地修改，使用服务器内容
          </button>
          <button
            type="button"
            disabled={submitting || overLimit}
            onClick={() => submit(conflict.version)}
          >
            提交人工合并后的输入（基于版本 {conflict.version}）
          </button>
        </section>
      ) : null}
      {initial && baseVersion !== initial.version && !conflict ? (
        <p role="status">
          服务器出现新版本 {initial.version}；本地输入仍基于 {baseVersion}，保存时将检查冲突。
        </p>
      ) : null}
      {restorable ? (
        <p role="status">
          发现未提交本地草稿（原版本 {restorable.baseVersion ?? '新建'}）。
          <button
            type="button"
            onClick={() => {
              const value = restorable.value as {
                title: string;
                summary: string;
                type: EntryType;
                tags: string;
                body: string;
              };
              setTitle(value.title);
              setSummary(value.summary);
              setType(value.type);
              setTags(value.tags);
              setBody(value.body);
              setBaseVersion(restorable.baseVersion);
              setRestorable(null);
            }}
          >
            恢复本地输入
          </button>
          <button type="button" onClick={() => exportLocal(restorable)}>
            导出原草稿
          </button>
        </p>
      ) : null}
      {draftMessage ? <p role="status">{draftMessage}</p> : null}
      <button
        type="button"
        onClick={() =>
          exportLocal({ title, summary, type, tags, body, baseVersion: initial?.version })
        }
      >
        导出当前输入
      </button>
      <div className={styles.editorGrid}>
        <label className={styles.field}>
          <span className={styles.label}>标题</span>
          <input
            className={styles.input}
            value={title}
            maxLength={200}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="一句话说明这条知识解决什么问题"
            data-testid="entry-title"
          />
        </label>
        <label className={styles.field}>
          <span className={styles.label}>类型</span>
          <select
            className={styles.input}
            value={type}
            onChange={(event) => setType(event.target.value as EntryType)}
          >
            {TYPE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <label className={styles.field}>
        <span className={styles.label}>摘要（转「已验证」前必填，≤300 字）</span>
        <input
          className={styles.input}
          value={summary}
          maxLength={300}
          onChange={(event) => setSummary(event.target.value)}
          placeholder="给未来的自己一句话结论"
          data-testid="entry-summary"
        />
      </label>

      <label className={styles.field}>
        <span className={styles.label}>标签（逗号分隔，最多 10 个）</span>
        <input
          className={styles.input}
          value={tags}
          onChange={(event) => setTags(event.target.value)}
          placeholder="React, 会话, 排错"
          data-testid="entry-tags"
        />
      </label>

      <label className={styles.field}>
        <span className={styles.label}>
          正文（Markdown，Ctrl/Cmd+Enter 保存）
          <span
            className={overLimit ? styles.byteOver : styles.byteCount}
            data-testid="byte-counter"
          >
            {formatBytes(bytes)} / {formatBytes(BODY_LIMIT_BYTES)}
          </span>
        </span>
        <textarea
          ref={bodyRef}
          className={styles.textarea}
          value={body}
          rows={12}
          onChange={(event) => setBody(event.target.value)}
          onKeyDown={onBodyKeyDown}
          placeholder={'## 结论\n\n- 支持列表、代码块、链接\n\n```ts\nconst answer = 42;\n```'}
          data-testid="entry-body"
        />
      </label>

      {overLimit ? (
        <p className={styles.error} role="alert">
          正文已超过 20480 字节（中文按 3 字节计算），保存被阻止。
        </p>
      ) : null}
      {localError === null ? null : (
        <p className={styles.error} role="alert">
          {localError}
        </p>
      )}
      {error === null || error === undefined ? null : (
        <p className={styles.error} role="alert">
          {describeApiError(error)}
          {fieldErrors.length > 0 ? `（${fieldErrors.join('；')}）` : ''}
        </p>
      )}

      <div className={styles.actions}>
        <button type="button" className={styles.secondary} onClick={onCancel} disabled={submitting}>
          取消
        </button>
        <button type="submit" className={styles.primary} disabled={submitting || overLimit}>
          {submitting ? '保存中…' : mode === 'create' ? '创建条目' : '保存修改'}
        </button>
      </div>
    </form>
  );
}
