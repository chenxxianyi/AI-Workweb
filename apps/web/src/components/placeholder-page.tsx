import type { ReactNode } from 'react';
import { EmptyState, PageHeader, Notice } from './states';

/**
 * 未实现模块的占位页（F07）。
 * 明确写出“将在哪个任务实现”，不显示任何伪造的成功状态。
 */
export function PlaceholderPage({
  title,
  description,
  plannedIn,
  requirements,
  children,
}: {
  title: string;
  description: string;
  plannedIn: string;
  requirements: string;
  children?: ReactNode;
}): React.JSX.Element {
  return (
    <>
      <PageHeader title={title} description={description} />
      <EmptyState
        title={`该模块将在 ${plannedIn} 实现`}
        description={`关联需求：${requirements}。当前只保留入口与布局，不做假数据与假保存。`}
      />
      {children === undefined ? null : <div style={{ marginTop: 'var(--space-4)' }}>{children}</div>}
      <div style={{ marginTop: 'var(--space-4)' }}>
        <Notice>
          骨架阶段说明：路由刷新与后退可用；切换空间会取消在途请求并清空缓存，避免旧空间数据串页。
        </Notice>
      </div>
    </>
  );
}
