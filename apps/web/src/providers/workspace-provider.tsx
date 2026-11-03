import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { EpochGuard } from '../services/workspace-guard';
import { useAuth } from './auth-provider';
import type { Membership, WorkspaceRole } from '../services/auth-api';

const STORAGE_KEY = 'aiwb.workspace';

interface WorkspaceContextValue {
  /** 当前空间为 null 表示用户还没有任何空间 */
  workspace: Membership | null;
  workspaces: Membership[];
  role: WorkspaceRole | null;
  switchTo: (workspaceId: string) => void;
  guard: EpochGuard;
  /** 权限判断只用于界面提示，真正的授权在后端 */
  can: (capability: 'business.write' | 'member.manage' | 'data.export' | 'data.import') => boolean;
}

const WorkspaceContext = createContext<WorkspaceContextValue | undefined>(undefined);

const ROLE_RANK: Record<WorkspaceRole, number> = { viewer: 1, editor: 2, owner: 3 };
const CAPABILITY_MIN: Record<
  'business.write' | 'member.manage' | 'data.export' | 'data.import',
  WorkspaceRole
> = {
  'business.write': 'editor',
  'member.manage': 'owner',
  'data.export': 'editor',
  'data.import': 'owner',
};

function readStoredWorkspace(): string | null {
  try {
    return globalThis.localStorage?.getItem(STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

/**
 * 空间上下文（F11）。
 *
 * - 空间列表来自 /auth/me 的 memberships（不再有占位数据）
 * - 选择持久化到 localStorage；切换时取消在途请求、清空缓存、递增 epoch
 * - 角色只用于界面（禁用/隐藏按钮 + 文案说明），后端守卫才是真正边界
 */
export function WorkspaceProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const { memberships, status } = useAuth();
  const queryClient = useQueryClient();
  const guardRef = useRef<EpochGuard>(new EpochGuard());
  const [selectedId, setSelectedId] = useState<string | null>(() => readStoredWorkspace());

  const workspaces = memberships;

  const current = useMemo<Membership | null>(() => {
    if (workspaces.length === 0) return null;
    const matched = workspaces.find((item) => item.workspaceId === selectedId);
    return matched ?? workspaces[0] ?? null;
  }, [workspaces, selectedId]);

  // 首次加载或当前空间失效时，回落到第一个可用空间
  useEffect(() => {
    if (current === null) return;
    if (current.workspaceId !== selectedId) {
      setSelectedId(current.workspaceId);
      try {
        globalThis.localStorage?.setItem(STORAGE_KEY, current.workspaceId);
      } catch {
        // 隐私模式写不进：仅影响下次打开
      }
    }
  }, [current, selectedId]);

  const switchTo = useCallback(
    (nextId: string) => {
      if (nextId === current?.workspaceId) return;
      guardRef.current.begin();
      void queryClient.cancelQueries();
      queryClient.clear();
      setSelectedId(nextId);
      try {
        globalThis.localStorage?.setItem(STORAGE_KEY, nextId);
      } catch {
        // 同上
      }
    },
    [current?.workspaceId, queryClient],
  );

  const can = useCallback<WorkspaceContextValue['can']>(
    (capability) => {
      if (current === null) return false;
      return ROLE_RANK[current.role] >= ROLE_RANK[CAPABILITY_MIN[capability]];
    },
    [current],
  );

  const value = useMemo<WorkspaceContextValue>(
    () => ({
      workspace: current,
      workspaces,
      role: current?.role ?? null,
      switchTo,
      guard: guardRef.current,
      can,
    }),
    [current, workspaces, switchTo, can],
  );

  // 未登录时不渲染子路由（ProtectedRoute 会处理跳转），避免空空间状态闪烁
  void status;

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): WorkspaceContextValue {
  const context = useContext(WorkspaceContext);
  if (context === undefined) throw new Error('useWorkspace 必须在 WorkspaceProvider 内使用');
  return context;
}
