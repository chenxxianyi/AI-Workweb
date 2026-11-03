import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { EpochGuard } from '../services/workspace-guard';

export interface WorkspaceSummary {
  id: string;
  name: string;
  role: 'owner' | 'editor' | 'viewer';
  /** 占位数据（F10/F11 接入真实接口后移除） */
  placeholder?: boolean;
}

interface WorkspaceContextValue {
  workspace: WorkspaceSummary;
  workspaces: WorkspaceSummary[];
  /** 切换空间：取消在途请求、清空缓存、递增 epoch，旧响应一律丢弃 */
  switchTo: (workspaceId: string) => void;
  guard: EpochGuard;
}

/** F07 占位空间；F10/F11 用 /workspaces 与 /auth/me 替换 */
const PLACEHOLDER_WORKSPACES: WorkspaceSummary[] = [
  { id: 'personal', name: '个人工作台', role: 'owner', placeholder: true },
  { id: 'team', name: '团队空间', role: 'editor', placeholder: true },
];

const WorkspaceContext = createContext<WorkspaceContextValue | undefined>(undefined);

export function WorkspaceProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const queryClient = useQueryClient();
  const guardRef = useRef<EpochGuard>(new EpochGuard());
  const [workspaceId, setWorkspaceId] = useState(PLACEHOLDER_WORKSPACES[0]!.id);

  const switchTo = useCallback(
    (nextId: string) => {
      if (nextId === workspaceId) return;
      // 1) 递增 epoch：旧结果即使后返回也不会被采用
      guardRef.current.begin();
      // 2) 取消在途查询并清空缓存，避免新空间看到旧空间数据
      void queryClient.cancelQueries();
      queryClient.clear();
      setWorkspaceId(nextId);
    },
    [queryClient, workspaceId],
  );

  const value = useMemo<WorkspaceContextValue>(() => {
    const workspace =
      PLACEHOLDER_WORKSPACES.find((item) => item.id === workspaceId) ?? PLACEHOLDER_WORKSPACES[0]!;
    return {
      workspace,
      workspaces: PLACEHOLDER_WORKSPACES,
      switchTo,
      guard: guardRef.current,
    };
  }, [workspaceId, switchTo]);

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): WorkspaceContextValue {
  const context = useContext(WorkspaceContext);
  if (context === undefined) throw new Error('useWorkspace 必须在 WorkspaceProvider 内使用');
  return context;
}
