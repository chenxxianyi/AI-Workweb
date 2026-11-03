import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { PageHeader, LoadingState, ErrorState, Notice } from '../../components/states';
import { useAuth } from '../../providers/auth-provider';
import { useTheme } from '../../providers/theme-provider';
import { useWorkspace } from '../../providers/workspace-provider';
import { authApi, describeApiError } from '../../services/auth-api';
import styles from './settings-page.module.css';

/**
 * 设置（F11 起可用）：
 * - 外观（本机偏好，F33 接服务端同步）
 * - 账号：修改密码（会吊销其他设备会话）
 * - 会话：列出本账号的有效会话，可逐个吊销或一次退出其他设备
 * - 空间：显示当前空间与角色（成员管理在 F34 页面化）
 */
export function SettingsPage(): React.JSX.Element {
  const { mode, resolved, setMode } = useTheme();
  const { user, refresh } = useAuth();
  const { workspace, role } = useWorkspace();
  const queryClient = useQueryClient();

  const sessionsQuery = useQuery({
    queryKey: ['auth', 'sessions'],
    queryFn: () => authApi.sessions(),
    staleTime: 10_000,
  });

  const revokeMutation = useMutation({
    mutationFn: (sessionId: string) => authApi.revokeSession(sessionId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['auth', 'sessions'] });
    },
  });

  const revokeOthersMutation = useMutation({
    mutationFn: () => authApi.revokeOtherSessions(),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['auth', 'sessions'] });
    },
  });

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordMessage, setPasswordMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  const passwordMutation = useMutation({
    mutationFn: () => authApi.changePassword(currentPassword, newPassword),
    onSuccess: (revoked) => {
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setPasswordMessage({
        tone: 'ok',
        text: `密码已修改；已吊销其他设备会话 ${revoked} 个。`,
      });
      void refresh();
      void queryClient.invalidateQueries({ queryKey: ['auth', 'sessions'] });
    },
    onError: (error) => {
      setPasswordMessage({ tone: 'error', text: describeApiError(error) });
    },
  });

  const submitPassword = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setPasswordMessage(null);
    if (newPassword !== confirmPassword) {
      setPasswordMessage({ tone: 'error', text: '两次输入的新密码不一致' });
      return;
    }
    passwordMutation.mutate();
  };

  return (
    <>
      <PageHeader
        title="设置"
        description="外观、账号安全与会话管理在当前版本可用；成员管理、回收站与导入导出在后续任务开放。"
      />

      <section className={styles.section} aria-labelledby="settings-profile">
        <h2 id="settings-profile" className={styles.heading}>
          账号
        </h2>
        <p className={styles.muted}>
          当前账号：{user?.displayName ?? '—'}（{user?.email ?? '—'}）
          {workspace === null ? null : (
            <>
              ；当前空间：{workspace.name}；角色：
              <span className={styles.role}>{role ?? '—'}</span>
            </>
          )}
        </p>
      </section>

      <section className={styles.section} aria-labelledby="settings-theme">
        <h2 id="settings-theme" className={styles.heading}>
          外观
        </h2>
        <p className={styles.muted}>
          当前：{mode === 'system' ? `跟随系统（${resolved === 'dark' ? '深色' : '浅色'}）` : mode === 'dark' ? '深色' : '浅色'}
          。偏好保存在本机，F33 接入服务端同步。
        </p>
        <div className={styles.row}>
          {(
            [
              ['system', '跟随系统'],
              ['light', '浅色'],
              ['dark', '深色'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={mode === value ? `${styles.chip} ${styles.chipActive}` : styles.chip}
              aria-pressed={mode === value}
              onClick={() => setMode(value)}
            >
              {label}
            </button>
          ))}
        </div>
      </section>

      <section className={styles.section} aria-labelledby="settings-password">
        <h2 id="settings-password" className={styles.heading}>
          修改密码
        </h2>
        <p className={styles.muted}>修改后其他设备的会话会被立即吊销；当前设备保持登录。</p>
        <form className={styles.form} onSubmit={submitPassword} noValidate>
          <label className={styles.field}>
            <span className={styles.label}>当前密码</span>
            <input
              className={styles.input}
              type="password"
              autoComplete="current-password"
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
              required
            />
          </label>
          <label className={styles.field}>
            <span className={styles.label}>新密码（至少 12 位、含三类字符）</span>
            <input
              className={styles.input}
              type="password"
              autoComplete="new-password"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              required
            />
          </label>
          <label className={styles.field}>
            <span className={styles.label}>确认新密码</span>
            <input
              className={styles.input}
              type="password"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              required
            />
          </label>
          {passwordMessage === null ? null : (
            <p
              className={passwordMessage.tone === 'ok' ? styles.ok : styles.error}
              role={passwordMessage.tone === 'ok' ? 'status' : 'alert'}
            >
              {passwordMessage.text}
            </p>
          )}
          <button type="submit" className={styles.primary} disabled={passwordMutation.isPending}>
            {passwordMutation.isPending ? '提交中…' : '修改密码'}
          </button>
        </form>
      </section>

      <section className={styles.section} aria-labelledby="settings-sessions">
        <h2 id="settings-sessions" className={styles.heading}>
          会话
        </h2>
        <p className={styles.muted}>列出生效中的会话；吊销后该设备的下一请求会要求重新登录。</p>
        {sessionsQuery.status === 'pending' ? <LoadingState label="加载会话…" /> : null}
        {sessionsQuery.status === 'error' ? (
          <ErrorState
            message={describeApiError(sessionsQuery.error)}
            onRetry={() => {
              void sessionsQuery.refetch();
            }}
          />
        ) : null}
        {sessionsQuery.status === 'success' ? (
          <div className={styles.list}>
            {sessionsQuery.data.sessions.map((session) => (
              <div key={session.id} className={styles.sessionRow}>
                <div>
                  <p className={styles.sessionTitle}>
                    {session.current ? '当前设备' : (session.userAgent ?? '未知设备')}
                  </p>
                  <p className={styles.sessionMeta}>
                    最近活跃：{new Date(session.lastSeenAt).toLocaleString('zh-CN')} · 绝对过期：
                    {new Date(session.absoluteExpiresAt).toLocaleString('zh-CN')}
                  </p>
                </div>
                {session.current ? (
                  <span className={styles.badge}>当前</span>
                ) : (
                  <button
                    type="button"
                    className={styles.danger}
                    onClick={() => revokeMutation.mutate(session.id)}
                    disabled={revokeMutation.isPending}
                  >
                    吊销
                  </button>
                )}
              </div>
            ))}
            {sessionsQuery.data.sessions.length > 1 ? (
              <button
                type="button"
                className={styles.secondary}
                onClick={() => revokeOthersMutation.mutate()}
                disabled={revokeOthersMutation.isPending}
              >
                退出其他所有设备
              </button>
            ) : null}
          </div>
        ) : null}
      </section>

      <section className={styles.section} aria-labelledby="settings-later">
        <h2 id="settings-later" className={styles.heading}>
          后续开放
        </h2>
        <Notice>
          成员与邀请（F34 页面化）、回收站（F34）、导入导出（F32）、空间时区（F33）将在对应任务接入；
          当前不显示不可用入口，也不伪造成功状态。
        </Notice>
      </section>
    </>
  );
}
