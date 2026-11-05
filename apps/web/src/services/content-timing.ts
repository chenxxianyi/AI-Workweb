import { useEffect } from 'react';
/** 本机性能验收：记录首个核心页面真实数据完成后的绘制时间；不上传遥测或业务内容。 */
export function useContentTiming(ready: boolean) {
  useEffect(() => {
    if (!ready || document.body.dataset['aiwbFirstContentMs']) return;
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => {
        if (!document.body.dataset['aiwbFirstContentMs'])
          document.body.dataset['aiwbFirstContentMs'] = performance.now().toFixed(1);
      });
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, [ready]);
}
