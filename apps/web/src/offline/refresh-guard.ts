import { useEffect } from 'react';
/** 输入属于当前挂载的编辑器；查询刷新不能清空它。应用壳更新/离线重载必须先处理输入。 */
export function useRefreshGuard(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return;
    const before = (event: Event) => event.preventDefault();
    const unload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('aiwb:before-refresh', before);
    window.addEventListener('beforeunload', unload);
    return () => {
      window.removeEventListener('aiwb:before-refresh', before);
      window.removeEventListener('beforeunload', unload);
    };
  }, [dirty]);
}
