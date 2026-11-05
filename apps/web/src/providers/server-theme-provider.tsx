import type { ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ThemeProvider, type ThemeMode } from './theme-provider';
import { useAuth } from './auth-provider';
import { apiClient } from '../services/api-client';
import { ensureCsrfToken } from '../services/auth-api';
interface Preference {
  theme: ThemeMode;
  version: number;
}
export function ServerThemeProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const { user, status } = useAuth(),
    client = useQueryClient();
  const key = ['user', user?.id ?? '', 'preferences'];
  const query = useQuery({
    queryKey: key,
    queryFn: () => apiClient.get<Preference>('/users/me/preferences'),
    enabled: status === 'authenticated',
    staleTime: 30000,
  });
  const save = async (theme: ThemeMode) => {
    const current =
      client.getQueryData<Preference>(key) ??
      (await client.fetchQuery({
        queryKey: key,
        queryFn: () => apiClient.get<Preference>('/users/me/preferences'),
      }));
    if(!current)throw new Error('个人偏好尚未加载');
    await ensureCsrfToken();
    try {
      const next = await apiClient.patch<Preference>(
        '/users/me/preferences',
        { theme },
        { ifMatch: current.version },
      );
      client.setQueryData(key, next);
    } catch (error) {
      void client.invalidateQueries({ queryKey: key });
      throw error;
    }
  };
  return (
    <ThemeProvider
      key={user?.id ?? status}
      storageScope={status === 'loading' ? undefined : (user?.id ?? 'anonymous')}
      serverMode={query.data?.theme}
      onChange={user ? save : undefined}
    >
      {children}
    </ThemeProvider>
  );
}
