import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { SearchPanel } from './search-panel';
import { GlobalTools } from './global-tools';
import { searchApi, type SearchResult } from '../../services/search-api';
import { kbApi } from '../../services/kb-api';

vi.mock('../../providers/workspace-provider', () => ({
  useWorkspace: () => ({ workspace: { workspaceId: 'space-a' }, can: () => true }),
}));
vi.mock('../../services/search-api', () => ({
  searchApi: { entries: vi.fn(), organize: vi.fn(), related: vi.fn() },
}));
vi.mock('../../services/kb-api', () => ({ kbApi: { create: vi.fn() } }));
const hit = (id: string, title: string) => ({
  id,
  title,
  summary: '摘要',
  tags: [],
  type: 'note' as const,
  status: 'draft' as const,
  score: 60,
  updatedAt: '2026-11-03T00:00:00.000Z',
});
function Location(): React.JSX.Element {
  const location = useLocation();
  return <output data-testid="location">{location.pathname + location.search}</output>;
}
function mount(initial = '/search', tools = false): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initial]}>
        <button onClick={() => window.dispatchEvent(new Event('aiwb:open-search'))}>
          触发搜索
        </button>
        {tools ? <GlobalTools /> : null}
        <Routes>
          <Route path="/search" element={<SearchPanel />} />
          <Route path="/kb/:id" element={<p>知识详情</p>} />
        </Routes>
        <Location />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(searchApi.entries).mockResolvedValue({
    hits: [hit('one', '断连方案一'), hit('two', '断连方案二')],
    hasMore: false,
    nextCursor: null,
    tookMs: 12,
  });
  vi.mocked(searchApi.organize).mockResolvedValue({
    top: [hit('top', '常用条目')],
    overdueDrafts: 2,
    staleEntries: 3,
  });
});
describe('F23 global search', () => {
  it('IME composition never opens capture or submits Ctrl+Enter prematurely', async () => {
    mount('/search', true);
    fireEvent.keyDown(window, { key: 'n', isComposing: true, keyCode: 229 });
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.keyDown(window, { key: 'n' });
    const body = await screen.findByRole('textbox', { name: '捕获正文' });
    fireEvent.change(body, { target: { value: '中文输入法组合' } });
    fireEvent.keyDown(body, { key: 'Enter', ctrlKey: true, isComposing: true, keyCode: 229 });
    expect(kbApi.create).not.toHaveBeenCalled();
    vi.mocked(kbApi.create).mockImplementation(() => new Promise(() => {}));
    fireEvent.keyDown(body, { key: 'Enter', ctrlKey: true, keyCode: 13 });
    await waitFor(()=>expect(kbApi.create).toHaveBeenCalledOnce());
  });
  it('empty query shows organization without sending empty search', async () => {
    mount();
    await screen.findByRole('link', { name: '常用条目' });
    expect(searchApi.entries).not.toHaveBeenCalled();
    expect(screen.getByText(/超期草稿/).textContent).toContain('2');
  });
  it('URL restores filters and arrows plus Enter open selected result', async () => {
    mount('/search?q=断连&status=draft&tag=网络');
    await screen.findByRole('link', { name: '断连方案二' });
    expect(searchApi.entries).toHaveBeenCalledWith(
      'space-a',
      expect.objectContaining({ q: '断连', status: 'draft', tag: '网络' }),
      expect.any(AbortSignal),
    );
    const input = screen.getByRole('textbox', { name: '搜索知识' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByTestId('location').textContent).toBe('/kb/two');
  });
  it('late cancelled result does not replace the newest query', async () => {
    let resolveOld: ((result: SearchResult) => void) | undefined;
    vi.mocked(searchApi.entries).mockImplementation((_workspace, filters) =>
      filters.q === '旧查询'
        ? new Promise((resolve) => {
            resolveOld = resolve;
          })
        : Promise.resolve({
            hits: [hit('new', '新查询结果')],
            hasMore: false,
            nextCursor: null,
            tookMs: 1,
          }),
    );
    mount('/search?q=旧查询');
    await waitFor(() => expect(searchApi.entries).toHaveBeenCalled());
    fireEvent.change(screen.getByRole('textbox', { name: '搜索知识' }), {
      target: { value: '新查询' },
    });
    await screen.findByRole('link', { name: '新查询结果' });
    resolveOld?.({
      hits: [hit('old', '旧查询结果')],
      hasMore: false,
      nextCursor: null,
      tookMs: 1000,
    });
    await waitFor(() => expect(screen.queryByRole('link', { name: '旧查询结果' })).toBeNull());
  });
  it('new filters remove a previous page cursor', async () => {
    mount('/search?q=断连&cursor=prior-page');
    await screen.findByRole('link', { name: '断连方案一' });
    fireEvent.change(screen.getByLabelText('搜索状态'), { target: { value: 'verified' } });
    await waitFor(() =>
      expect(screen.getByTestId('location').textContent).toContain('status=verified'),
    );
    expect(screen.getByTestId('location').textContent).not.toContain('cursor');
  });
  it('zero result offers creation rather than blank UI', async () => {
    vi.mocked(searchApi.entries).mockResolvedValue({
      hits: [],
      hasMore: false,
      nextCursor: null,
      tookMs: 1,
    });
    mount('/search?q=不存在');
    expect(await screen.findByRole('button', { name: '用它新建草稿' })).toBeTruthy();
  });
  it('shortcut opens one dialog, focuses query, Esc restores trigger', async () => {
    mount('/search', true);
    const trigger = screen.getByRole('button', { name: '触发搜索' });
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = await screen.findByRole('dialog', { name: '全局搜索' });
    expect(dialog.querySelector('input')).toBe(document.activeElement);
    fireEvent.keyDown(document.activeElement as Element, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });
  it('N in an input does not capture and Ctrl+K does not discard capture text', async () => {
    mount('/search', true);
    const searchInput = screen.getByRole('textbox', { name: '搜索知识' });
    fireEvent.keyDown(searchInput, { key: 'n' });
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.keyDown(window, { key: 'n' });
    const title = await screen.findByRole('textbox', { name: '捕获标题' });
    fireEvent.change(title, { target: { value: '未保存内容' } });
    fireEvent.keyDown(title, { key: 'k', ctrlKey: true });
    expect(screen.getByRole('dialog', { name: '快速捕获' })).toBeTruthy();
    expect((title as HTMLInputElement).value).toBe('未保存内容');
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
  });
});
