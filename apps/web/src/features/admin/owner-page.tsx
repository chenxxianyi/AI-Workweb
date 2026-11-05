import { Link } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useWorkspace } from '../../providers/workspace-provider';
export function OwnerPage({
  children,
}: {
  children: (workspaceId: string) => ReactNode;
}): React.JSX.Element {
  const { workspace, role } = useWorkspace();
  return (
    <>
      <p>
        <Link to="/settings">返回设置</Link>
      </p>
      {workspace && role === 'owner' ? (
        children(workspace.workspaceId)
      ) : (
        <p>仅Owner可查看和维护本空间管理内容。</p>
      )}
    </>
  );
}
