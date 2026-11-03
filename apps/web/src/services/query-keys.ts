/**
 * 查询键（F07）：一律以 workspaceId 开头，切换空间后旧空间的缓存不会被新页面复用。
 * 约定：['ws', workspaceId, resource, ...params]
 */
export const queryKeys = {
  healthLive: () => ['health', 'live'] as const,
  workspaces: () => ['workspaces'] as const,
  today: (workspaceId: string, date: string) => ['ws', workspaceId, 'today', date] as const,
  projects: (workspaceId: string, filters: Record<string, unknown> = {}) =>
    ['ws', workspaceId, 'projects', filters] as const,
  project: (workspaceId: string, projectId: string) =>
    ['ws', workspaceId, 'project', projectId] as const,
  tasks: (workspaceId: string, filters: Record<string, unknown> = {}) =>
    ['ws', workspaceId, 'tasks', filters] as const,
  entries: (workspaceId: string, filters: Record<string, unknown> = {}) =>
    ['ws', workspaceId, 'entries', filters] as const,
  entry: (workspaceId: string, entryId: string) => ['ws', workspaceId, 'entry', entryId] as const,
  ledger: (workspaceId: string, month: string) => ['ws', workspaceId, 'ledger', month] as const,
  monthlyAnalytics: (workspaceId: string, month: string) =>
    ['ws', workspaceId, 'analytics', 'monthly', month] as const,
  weeklyAnalytics: (workspaceId: string) => ['ws', workspaceId, 'analytics', 'weekly'] as const,
  search: (workspaceId: string, term: string) => ['ws', workspaceId, 'search', term] as const,
  preferences: (workspaceId: string) => ['ws', workspaceId, 'preferences'] as const,
} as const;
