import { useMemo, useRef, useState } from 'react';
import { ApiError } from '../../services/api-client';
import { describeApiError } from '../../services/auth-api';
import type { Entry, EntryInput, EntryType } from '../../services/kb-api';
import { BODY_LIMIT_BYTES, TYPE_OPTIONS, formatBytes, isSaveShortcut, utf8Bytes } from './kb-utils';
import styles from './kb.module.css';

interface EntryEditorProps {
  mode: 'create' | 'edit';
  initial?: Entry;
  submitting: boolean;
  error: unknown;
  onSubmit: (input: EntryInput) => void;
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
  const [localError, setLocalError] = useState<string | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);

  const bytes = useMemo(() => utf8Bytes(body), [body]);
  const overLimit = bytes > BODY_LIMIT_BYTES;

  const fieldErrors =
    error instanceof ApiError && error.fieldErrors !== undefined
      ? Object.entries(error.fieldErrors).map(([field, messages]) => `${field}：${messages.join('、')}`)
      : [];

  const submit = (): void => {
    setLocalError(null);
    if (overLimit) {
      setLocalError(`正文 ${formatBytes(bytes)} 超过 ${formatBytes(BODY_LIMIT_BYTES)} 上限，请精简后再保存`);
      return;
    }
    if (mode === 'create' && title.trim() === '' && body.trim() === '') {
      setLocalError('至少填写标题或正文');
      return;
    }
    onSubmit({
      type,
      title: title.trim(),
      summary: summary.trim() === '' ? null : summary.trim(),
      body,
      tags: tags
        .split(/[,，]/)
        .map((tag) => tag.trim())
        .filter((tag) => tag !== ''),
    });
  };

  const onBodyKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
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
          <select className={styles.input} value={type} onChange={(event) => setType(event.target.value as EntryType)}>
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
          <span className={overLimit ? styles.byteOver : styles.byteCount} data-testid="byte-counter">
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
