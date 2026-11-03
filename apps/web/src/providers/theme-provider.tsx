import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

export type ThemeMode = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

const STORAGE_KEY = 'aiwb.theme';

interface ThemeContextValue {
  mode: ThemeMode;
  resolved: ResolvedTheme;
  setMode: (mode: ThemeMode) => void;
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

function readStoredMode(): ThemeMode {
  try {
    const stored = globalThis.localStorage?.getItem(STORAGE_KEY);
    return stored === 'light' || stored === 'dark' || stored === 'system' ? stored : 'system';
  } catch {
    return 'system';
  }
}

export function systemTheme(): ResolvedTheme {
  const match = globalThis.matchMedia?.('(prefers-color-scheme: dark)');
  return match?.matches === true ? 'dark' : 'light';
}

export function resolveTheme(mode: ThemeMode, system: ResolvedTheme = systemTheme()): ResolvedTheme {
  return mode === 'system' ? system : mode;
}

/**
 * 主题（F07，ADR-0007）：`data-theme` 挂在 <html>，首屏由 index.html 的内联脚本先应用，
 * 这里只负责运行时切换与持久化，避免刷新闪白。
 */
export function ThemeProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [mode, setModeState] = useState<ThemeMode>(() => readStoredMode());
  const [system, setSystem] = useState<ResolvedTheme>(() => systemTheme());

  const resolved = resolveTheme(mode, system);

  useEffect(() => {
    const match = globalThis.matchMedia?.('(prefers-color-scheme: dark)');
    if (match === undefined) return;
    const listener = (event: MediaQueryListEvent): void => {
      setSystem(event.matches ? 'dark' : 'light');
    };
    match.addEventListener('change', listener);
    return () => {
      match.removeEventListener('change', listener);
    };
  }, []);

  useEffect(() => {
    document.documentElement.dataset['theme'] = resolved;
  }, [resolved]);

  const setMode = useCallback((next: ThemeMode) => {
    setModeState(next);
    try {
      globalThis.localStorage?.setItem(STORAGE_KEY, next);
    } catch {
      // 隐私模式下写不进：只影响下次打开的偏好，不阻断使用
    }
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({ mode, resolved, setMode }),
    [mode, resolved, setMode],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (context === undefined) throw new Error('useTheme 必须在 ThemeProvider 内使用');
  return context;
}
