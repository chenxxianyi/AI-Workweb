import { useCallback, useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useWorkspace } from '../../providers/workspace-provider';
import { kbApi } from '../../services/kb-api';
import { newIdempotencyKey } from '../../services/tasks-api';
import { describeApiError } from '../../services/auth-api';
import { shouldIgnoreShortcut, utf8Bytes } from '../kb/kb-utils';
import { SearchPanel } from './search-panel';
import styles from './search.module.css';
import { useRefreshGuard } from '../../offline/refresh-guard';
import { useDraftFlush } from '../../offline/draft-flush';
import { deleteLocalRecord, loadDraft, saveDraft, exportLocal } from '../../offline/queue';

export function GlobalTools({ userId }: { userId?: string | undefined } = {}): React.JSX.Element {
  const { workspace, can } = useWorkspace();
  const workspaceId = workspace?.workspaceId ?? '';
  const [mode, setMode] = useState<'search' | 'capture' | null>(null);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [message, setMessage] = useState('');
  const dialog = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const retryKey = useRef<string | null>(null);
  const client = useQueryClient();
  const typed = useRef(false);
  useRefreshGuard(!!title || !!body);
  useDraftFlush(!!userId && (!!title || !!body), () =>
    userId ? saveDraft(userId, workspaceId, 'quick-capture', { title, body }) : Promise.resolve(),
  );
  useEffect(() => {
    let active = true;
    if (userId)
      void loadDraft(userId, workspaceId, 'quick-capture')
        .then((draft) => {
          if (active && draft && !typed.current) {
            const value = draft.value as { title: string; body: string };
            setTitle(value.title);
            setBody(value.body);
            setMessage('已恢复本机捕获草稿，尚未提交。');
          }
        })
        .catch(() => setMessage('本机存储不可用，请导出当前捕获内容。'));
    return () => {
      active = false;
    };
  }, [userId, workspaceId]);
  useEffect(() => {
    if (!userId || (!title && !body)) return;
    const timer = setTimeout(() => {
      void saveDraft(userId, workspaceId, 'quick-capture', { title, body }).catch(() =>
        setMessage('本机草稿保存失败，请导出当前捕获内容。'),
      );
    }, 200);
    return () => clearTimeout(timer);
  }, [userId, workspaceId, title, body]);
  const close = useCallback(() => setMode(null), []);
  const save = useMutation({
    mutationFn: () => {
      retryKey.current ??= newIdempotencyKey();
      return kbApi.create(
        workspaceId,
        { title: title.trim(), body, type: 'note' },
        retryKey.current,
      );
    },
    onSuccess: () => {
      if (userId) void deleteLocalRecord('drafts', userId + ':' + workspaceId + ':quick-capture');
      void client.invalidateQueries({ queryKey: ['ws', workspaceId] });
      retryKey.current = null;
      setTitle('');
      setBody('');
      setMessage('草稿已保存，可在知识库补充摘要。');
      close();
    },
  });
  useEffect(() => {
    setMode(null);
  }, [workspaceId]);
  useEffect(() => {
    const openSearch = (): void => {
      if (mode === 'capture') return;
      if (mode === null) trigger.current = document.activeElement as HTMLElement;
      setMode('search');
    };
    const openCapture = (event?: Event): void => {
      if (!can('business.write')) return;
      if (mode === null) trigger.current = document.activeElement as HTMLElement;
      if (!title && !body)
        setTitle((event as CustomEvent<{ title?: string }> | undefined)?.detail?.title ?? '');
      setMode('capture');
    };
    const hotkey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        openSearch();
      }
      if (
        mode === null &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        event.key.toLowerCase() === 'n' &&
        !shouldIgnoreShortcut(event.target as HTMLElement)
      ) {
        event.preventDefault();
        openCapture();
      }
    };
    window.addEventListener('keydown', hotkey);
    window.addEventListener('aiwb:open-search', openSearch);
    window.addEventListener('aiwb:open-capture', openCapture);
    return () => {
      window.removeEventListener('keydown', hotkey);
      window.removeEventListener('aiwb:open-search', openSearch);
      window.removeEventListener('aiwb:open-capture', openCapture);
    };
  }, [can, mode, save, title, body]);
  useEffect(() => {
    if (mode === null) return;
    const activeDialog = dialog.current;
    (
      activeDialog?.querySelector<HTMLElement>('input') ??
      activeDialog?.querySelector<HTMLElement>('button')
    )?.focus();
    const trap = (event: KeyboardEvent): void => {
      if (event.isComposing) return;
      if (event.key === 'Escape' && !save.isPending) {
        event.preventDefault();
        close();
      }
      if (event.key !== 'Tab') return;
      const focusable = [
        ...(activeDialog?.querySelectorAll<HTMLElement>(
          'a[href],button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled])',
        ) ?? []),
      ];
      const first = focusable[0],
        last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    activeDialog?.addEventListener('keydown', trap);
    return () => {
      activeDialog?.removeEventListener('keydown', trap);
      if (trigger.current?.isConnected) trigger.current.focus();
    };
  }, [mode, close, save.isPending]);
  const tooLarge = utf8Bytes(body) > 20480;
  return (
    <>
      {message ? (
        <p role="status" className={styles.toast}>
          {message} <Link to="/kb">查看知识库</Link>
          <button onClick={() => setMessage('')}>关闭</button>
        </p>
      ) : null}
      {mode === null ? null : (
        <div className={styles.backdrop}>
          <div
            ref={dialog}
            className={styles.dialog}
            role="dialog"
            aria-modal="true"
            aria-label={mode === 'search' ? '全局搜索' : '快速捕获'}
          >
            <header className={styles.dialogHeader}>
              <h2>{mode === 'search' ? '全局搜索' : '快速捕获'}</h2>
              <button onClick={close} disabled={save.isPending} aria-label="关闭浮层">
                关闭 Esc
              </button>
            </header>
            {mode === 'search' ? (
              <SearchPanel modal onChoose={close} />
            ) : (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!save.isPending && !tooLarge && (title.trim() || body.trim())) save.mutate();
                }}
                onKeyDown={(event) => {
                  if (
                    !event.nativeEvent.isComposing &&
                    event.nativeEvent.keyCode !== 229 &&
                    event.key === 'Enter' &&
                    (event.ctrlKey || event.metaKey)
                  ) {
                    event.preventDefault();
                    event.currentTarget.requestSubmit();
                  }
                }}
              >
                <label className={styles.field}>
                  标题
                  <input
                    aria-label="捕获标题"
                    value={title}
                    maxLength={200}
                    onChange={(event) => {
                      typed.current = true;
                      setTitle(event.target.value);
                    }}
                    disabled={save.isPending}
                  />
                </label>
                <label className={styles.field}>
                  正文
                  <textarea
                    aria-label="捕获正文"
                    rows={10}
                    value={body}
                    onChange={(event) => {
                      typed.current = true;
                      setBody(event.target.value);
                    }}
                    disabled={save.isPending}
                  />
                </label>
                <button type="button" onClick={() => exportLocal({ title, body })}>
                  导出当前捕获
                </button>
                <p>关闭浮层保留本机输入，可再次打开继续编辑。</p>
                <p>{utf8Bytes(body)} / 20480字节</p>
                {tooLarge ? <p role="alert">正文超过20KB，请精简。</p> : null}
                {save.isError ? <p role="alert">{describeApiError(save.error)}</p> : null}
                <button
                  type="submit"
                  disabled={save.isPending || tooLarge || (!title.trim() && !body.trim())}
                >
                  {save.isPending ? '保存中…' : '保存草稿 Ctrl/Cmd+Enter'}
                </button>
              </form>
            )}
          </div>
        </div>
      )}
    </>
  );
}
