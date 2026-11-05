import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../../services/api-client';
import { describeApiError, ensureCsrfToken } from '../../services/auth-api';
import { PageHeader, LoadingState, ErrorState } from '../../components/states';
import { ConfirmationDialog } from '../../components/confirmation-dialog';
import { OwnerPage } from './owner-page';
import { useAuth } from '../../providers/auth-provider';
import styles from '../settings/settings-page.module.css';
interface Member {
  userId: string;
  displayName: string;
  email: string;
  role: string;
  version: number;
  isLastOwner: boolean;
}
interface Invitation {
  id: string;
  email: string;
  role: string;
  expiresAt: string;
  expired: boolean;
}
export function TeamPage(): React.JSX.Element {
  return <OwnerPage>{(id) => <Team key={id} workspaceId={id} />}</OwnerPage>;
}
function Team({ workspaceId }: { workspaceId: string }): React.JSX.Element {
  const { refresh } = useAuth();
  const base = '/workspaces/' + workspaceId,
    client = useQueryClient();
  const [email, setEmail] = useState(''),
    [role, setRole] = useState('editor'),
    [createdLink, setCreatedLink] = useState(''),
    [remove, setRemove] = useState<Member | null>(null),
    [grant, setGrant] = useState<{ member: Member; role: string } | null>(null);
  const members = useQuery({
    queryKey: ['ws', workspaceId, 'members'],
    queryFn: () => apiClient.get<{ members: Member[] }>(base + '/members'),
  });
  const invitations = useQuery({
    queryKey: ['ws', workspaceId, 'invitations'],
    queryFn: () => apiClient.get<{ invitations: Invitation[] }>(base + '/invitations'),
  });
  const changed = () => {
    void client.invalidateQueries({ queryKey: ['ws', workspaceId] });
    void refresh();
  };
  const invite = useMutation({
    mutationFn: async () => {
      await ensureCsrfToken();
      return apiClient.post<{ token: string }>(base + '/invitations', { email, role });
    },
    onSuccess: (r) => {
      setCreatedLink(location.origin + '/invite?token=' + encodeURIComponent(r.token));
      setEmail('');
      changed();
    },
  });
  const revoke = useMutation({
    mutationFn: async (id: string) => {
      await ensureCsrfToken();
      return apiClient.del(base + '/invitations/' + id);
    },
    onSuccess: changed,
  });
  const changeRole = useMutation({
    mutationFn: async () => {
      await ensureCsrfToken();
      return apiClient.patch(
        base + '/members/' + grant!.member.userId,
        { role: grant!.role },
        { ifMatch: grant!.member.version },
      );
    },
    onSuccess: () => {
      setGrant(null);
      changed();
    },
  });
  const removeMember = useMutation({
    mutationFn: async () => {
      await ensureCsrfToken();
      return apiClient.del(base + '/members/' + remove!.userId);
    },
    onSuccess: () => {
      setRemove(null);
      changed();
    },
  });
  const error = invite.error ?? revoke.error ?? changeRole.error ?? removeMember.error;
  return (
    <>
      <PageHeader
        title="成员与邀请"
        description="Owner管理成员和角色，空间始终至少保留一位Owner。邀请链接仅创建时显示，不自动发送。"
      />
      {error ? <p role="alert">{describeApiError(error)}</p> : null}
      <section className={styles.section}>
        <h2>邀请成员</h2>
        <form
          className={styles.form}
          onSubmit={(e) => {
            e.preventDefault();
            setCreatedLink('');
            invite.mutate();
          }}
        >
          <label className={styles.field}>
            受邀邮箱
            <input
              className={styles.input}
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          <label className={styles.field}>
            初始角色
            <select className={styles.input} value={role} onChange={(e) => setRole(e.target.value)}>
              <option value="editor">Editor（编辑）</option>
              <option value="viewer">Viewer（只读）</option>
            </select>
          </label>
          <button className={styles.primary} disabled={invite.isPending}>
            {invite.isPending ? '创建中…' : '创建邀请链接'}
          </button>
        </form>
        {createdLink ? (
          <div>
            <p>链接仅本次显示，请手动交给受邀人；不会保存到普通页面缓存。</p>
            <label className={styles.field}>
              本次邀请链接
              <input className={styles.input} readOnly value={createdLink} />
            </label>
            <button className={styles.chip} onClick={() => setCreatedLink('')}>
              隐藏链接
            </button>
          </div>
        ) : null}
      </section>
      <section className={styles.section}>
        <h2>当前成员</h2>
        {members.isPending ? (
          <LoadingState />
        ) : members.isError ? (
          <ErrorState
            message={describeApiError(members.error)}
            onRetry={() => void members.refetch()}
          />
        ) : (
          <ul>
            {members.data.members.map((member) => (
              <li key={member.userId}>
                <p>
                  {member.displayName} · {member.email} · {member.role}
                  {member.isLastOwner ? '（最后一位Owner）' : ''}
                </p>
                <div className={styles.row}>
                  <button
                    className={styles.secondary}
                    onClick={() => setGrant({ member, role: member.role })}
                  >
                    更改角色
                  </button>
                  <button
                    className={styles.danger}
                    disabled={member.isLastOwner}
                    onClick={() => setRemove(member)}
                  >
                    移除成员
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className={styles.section}>
        <h2>待接受邀请</h2>
        {invitations.isPending ? (
          <LoadingState />
        ) : invitations.isError ? (
          <ErrorState
            message={describeApiError(invitations.error)}
            onRetry={() => void invitations.refetch()}
          />
        ) : invitations.data.invitations.length === 0 ? (
          <p>暂无邀请。</p>
        ) : (
          <ul>
            {invitations.data.invitations.map((item) => (
              <li key={item.id}>
                {item.email} · {item.role} ·{' '}
                {item.expired ? '已过期' : '有效至' + new Date(item.expiresAt).toLocaleString()}
                <button
                  className={styles.chip}
                  disabled={revoke.isPending}
                  onClick={() => revoke.mutate(item.id)}
                >
                  撤销邀请
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      {grant ? (
        <ConfirmationDialog
          title={'确认更改 ' + grant.member.displayName + ' 的角色'}
          busy={changeRole.isPending}
          onClose={() => setGrant(null)}
        >
          <label className={styles.field}>
            新角色
            <select
              className={styles.input}
              value={grant.role}
              onChange={(e) => setGrant({ ...grant, role: e.target.value })}
            >
              {['owner', 'editor', 'viewer'].map((role) => (
                <option
                  key={role}
                  value={role}
                  disabled={grant.member.isLastOwner && role !== 'owner'}
                >
                  {role}
                </option>
              ))}
            </select>
          </label>
          <p>Owner可以导入、彻底删除和管理成员；请核对权限范围。</p>
          <button
            disabled={changeRole.isPending || grant.role === grant.member.role}
            onClick={() => changeRole.mutate()}
          >
            确认更改角色
          </button>
        </ConfirmationDialog>
      ) : null}
      {remove ? (
        <ConfirmationDialog
          title="确认移除成员"
          busy={removeMember.isPending}
          onClose={() => setRemove(null)}
        >
          <p>移除{remove.displayName}后，对方会话会被吊销，已有业务记录保留。</p>
          <button disabled={removeMember.isPending} onClick={() => removeMember.mutate()}>
            确认移除成员
          </button>
        </ConfirmationDialog>
      ) : null}
    </>
  );
}
