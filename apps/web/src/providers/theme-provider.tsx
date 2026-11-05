import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';

export type ThemeMode = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

const STORAGE_KEY = 'aiwb.theme';

interface ThemeContextValue {
  mode: ThemeMode;
  resolved: ResolvedTheme;
  setMode: (mode: ThemeMode) => void;
  syncError: string | null;
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

function readStoredMode(scope?: string): ThemeMode {
  try {
    const stored = globalThis.localStorage?.getItem(
      scope ? STORAGE_KEY + '.' + scope : STORAGE_KEY,
    );
    return stored === 'light' || stored === 'dark' || stored === 'system' ? stored : 'system';
  } catch {
    return 'system';
  }
}

export function systemTheme(): ResolvedTheme {
  const match = globalThis.matchMedia?.('(prefers-color-scheme: dark)');
  return match?.matches === true ? 'dark' : 'light';
}

export function resolveTheme(
  mode: ThemeMode,
  system: ResolvedTheme = systemTheme(),
): ResolvedTheme {
  return mode === 'system' ? system : mode;
}

/**
 * 主题（F07，ADR-0007）：`data-theme` 挂在 <html>，首屏由 index.html 的内联脚本先应用，
 * 这里只负责运行时切换与持久化，避免刷新闪白。
 */
export function ThemeProvider({
  children,
  storageScope,
  serverMode,
  onChange,
}: {
  children: ReactNode;
  storageScope?: string;
  serverMode?: ThemeMode;
  onChange?: (mode: ThemeMode) => Promise<void>;
}): React.JSX.Element {
  const [mode, setModeState] = useState<ThemeMode>(() => readStoredMode(storageScope));
  const [syncError, setSyncError] = useState<string | null>(null);
  const saving = useRef(false);
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

  const persist = useCallback(
    (next: ThemeMode) => {
      try {
        globalThis.localStorage?.setItem(STORAGE_KEY, next);
        if (storageScope) globalThis.localStorage?.setItem(STORAGE_KEY + '.' + storageScope, next);
      } catch {
        /* 本机缓存异常不阻断服务器偏好或业务保存。 */
      }
    },
    [storageScope],
  );
  useEffect(() => {
    if (serverMode) {
      setModeState(serverMode);
      persist(serverMode);
    }
  }, [serverMode, persist]);

  const setMode = useCallback(
    (next: ThemeMode) => {
      if (saving.current) return;
      setModeState(next);
      persist(next);
      setSyncError(null);
      if (onChange) {
        saving.current = true;
        void onChange(next)
          .catch(() => setSyncError('主题已在本机切换，服务器偏好尚未保存；请重新选择以重试。'))
          .finally(() => {
            saving.current = false;
          });
      }
    },
    [onChange, persist],
  );

  const value = useMemo<ThemeContextValue>(
    () => ({ mode, resolved, setMode, syncError }),
    [mode, resolved, setMode, syncError],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (context === undefined) throw new Error('useTheme 必须在 ThemeProvider 内使用');
  return context;
}
