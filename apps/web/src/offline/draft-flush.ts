import { useEffect } from 'react';
/** 退出/换账号前立即落盘当前输入，不能让200ms防抖与清理账号数据产生丢稿竞态。 */
export async function flushActiveDrafts() {
  const pending: Promise<unknown>[] = [];
  window.dispatchEvent(new CustomEvent('aiwb:flush-drafts', { detail: pending }));
  try {
    await Promise.all(pending);
  } catch {
    throw new Error('当前输入未能保存到本机，请先导出或处理输入再退出。');
  }
}
export function useDraftFlush(active: boolean, save: () => Promise<unknown>) {
  useEffect(() => {
    if (!active) return;
    const flush = (event: Event) => {
      (event as CustomEvent<Promise<unknown>[]>).detail.push(save());
    };
    window.addEventListener('aiwb:flush-drafts', flush);
    return () => window.removeEventListener('aiwb:flush-drafts', flush);
  }, [active, save]);
}
