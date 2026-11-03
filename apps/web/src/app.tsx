import { useEffect, useState } from 'react';
import './styles/bootstrap.css';

type HealthState = 'checking' | 'ok' | 'error';

/**
 * 最小前端壳（F04）：验证"前端构建 + API 同源代理 + 契约类型"三者已接通。
 * F07 替换为真正的路由、布局、主题令牌、请求层与状态组件。
 */
export function App(): React.JSX.Element {
  const [health, setHealth] = useState<HealthState>('checking');

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/v1/health/live', { signal: controller.signal, headers: { Accept: 'application/json' } })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return (await response.json()) as { data?: { status?: string } };
      })
      .then((body) => {
        setHealth(body.data?.status === 'ok' ? 'ok' : 'error');
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setHealth('error');
      });
    return () => {
      controller.abort();
    };
  }, []);

  const label =
    health === 'ok' ? '后端已连接' : health === 'error' ? '后端未连接（检查 API_PORT）' : '检查中…';

  return (
    <main className="bootstrap">
      <h1>AI 编程工作台</h1>
      <p>工程骨架已建立（F04）。页面与业务功能在 F07 起逐步实现。</p>
      <p className={`bootstrap__health bootstrap__health--${health}`} role="status">
        {label}
      </p>
    </main>
  );
}
