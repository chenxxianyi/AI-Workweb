import { useMutation, useQuery } from '@tanstack/react-query';
import { useAuth } from '../providers/auth-provider';
import { useWorkspace } from '../providers/workspace-provider';
import { clearSnapshots, transaction, type Snapshot } from './store';
import styles from '../features/settings/settings-page.module.css';
export async function cacheStatus(userId: string, workspaceId: string) {
  const names =
    'caches' in globalThis
      ? (await caches.keys()).filter((n) => n.startsWith('aiwb-shell-v1-'))
      : [];
  let staticFiles = 0,
    unexpected = 0;
  for (const name of names) {
    const requests = await (await caches.open(name)).keys();
    for (const request of requests) {
      staticFiles++;
      const p = new URL(request.url).pathname;
      if (
        !['/index.html', '/manifest.webmanifest', '/app-icon.svg'].includes(p) &&
        !/^\/assets\/[^/]+\.(js|css|woff2?|svg|png)$/.test(p)
      )
        unexpected++;
    }
  }
  const privateViews = await transaction<Snapshot[]>('snapshots', 'readonly', (s) =>
    s.index('scope').getAll(userId + ':' + workspaceId),
  );
  return {
    shellReady: names.length > 0,
    staticFiles,
    unexpected,
    privateViews: privateViews.length,
  };
}
export function OfflineCacheSettings(): React.JSX.Element | null {
  const { user } = useAuth(),
    { workspace } = useWorkspace();
  return user && workspace ? (
    <Settings
      key={user.id + workspace.workspaceId}
      userId={user.id}
      workspaceId={workspace.workspaceId}
    />
  ) : null;
}
function Settings({
  userId,
  workspaceId,
}: {
  userId: string;
  workspaceId: string;
}): React.JSX.Element {
  const query = useQuery({
    queryKey: ['user', userId, 'ws', workspaceId, 'cache-status'],
    queryFn: () => cacheStatus(userId, workspaceId),
    refetchInterval: 5000,
  });
  const clear = useMutation({
    mutationFn: () => clearSnapshots(userId, workspaceId),
    onSuccess: () => void query.refetch(),
  });
  return (
    <section className={styles.section} aria-label="本机离线资料">
      <h2>本机离线资料</h2>
      <p>
        仅保存本账号、本空间近期业务的只读副本，最多50个视图、7天内可用。服务器统计、团队、认证、邀请和下载不会保存到共享缓存。
      </p>
      {query.isSuccess ? (
        <>
          <p>
            应用壳：{query.data.shellReady ? '已缓存，可离线打开' : '尚未缓存，仅正式构建支持'}
            ；公开静态文件 {query.data.staticFiles} 个。
          </p>
          <p>
            共享缓存异常响应：{query.data.unexpected} 个；本空间只读视图：{query.data.privateViews}{' '}
            个。
          </p>
        </>
      ) : (
        <p>
          {query.isError
            ? '浏览器未提供可用的本机离线存储；正常服务器保存仍可使用。'
            : '正在检查本机缓存…'}
        </p>
      )}
      <button
        className={styles.secondary}
        disabled={clear.isPending}
        onClick={() => clear.mutate()}
      >
        清除此空间只读副本
      </button>
      {clear.isSuccess ? (
        <p role="status">
          本空间只读副本已清除。之后访问业务页面可能重新生成；退出账号会清理本人本机私有资料。
        </p>
      ) : null}
      {clear.isError ? <p role="alert">本机副本清理失败，请检查浏览器存储权限。</p> : null}
    </section>
  );
}
