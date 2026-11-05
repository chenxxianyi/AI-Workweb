import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { EntryEditor } from '../features/kb/entry-editor';
import type { Entry } from '../services/kb-api';
import { activeRefreshInterval } from '../providers/query-provider';
const original: Entry = {
  id: 'entry',
  type: 'note',
  title: '原标题',
  summary: null,
  body: '原正文',
  tags: [],
  version: 1,
  status: 'draft',
  lang: null,
  projectId: null,
  source: null,
  rating: null,
  createdAt: '2026-11-04T00:00:00Z',
  updatedAt: '2026-11-04T00:00:00Z',
  bodyBytes: 9,
};
describe('editing concurrency and refresh', () => {
  it('background new version cannot replace typed input or its original version', () => {
    const submit = vi.fn(),
      view = render(
        <EntryEditor
          mode="edit"
          initial={original}
          submitting={false}
          error={null}
          onSubmit={submit}
          onCancel={() => {}}
        />,
      );
    fireEvent.change(screen.getByTestId('entry-body'), { target: { value: '设备B未提交正文' } });
    view.rerender(
      <EntryEditor
        mode="edit"
        initial={{ ...original, version: 2, body: '设备A正文' }}
        submitting={false}
        error={null}
        onSubmit={submit}
        onCancel={() => {}}
      />,
    );
    expect((screen.getByTestId('entry-body') as HTMLTextAreaElement).value).toBe('设备B未提交正文');
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));
    expect(submit.mock.calls[0]?.[1]).toBe(1);
    expect(submit.mock.calls[0]?.[0].body).toBe('设备B未提交正文');
  });
  it('shows server diff and requires explicit merged submission using new version', () => {
    const submit = vi.fn();
    render(
      <EntryEditor
        mode="edit"
        initial={original}
        conflict={{ ...original, version: 2, body: '服务器A内容' }}
        submitting={false}
        error={null}
        onSubmit={submit}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByRole('alert').textContent).toContain('服务器A内容');
    fireEvent.change(screen.getByTestId('entry-body'), { target: { value: '人工合并A+B' } });
    fireEvent.click(screen.getByRole('button', { name: '提交人工合并后的输入（基于版本 2）' }));
    expect(submit.mock.calls[0]?.[1]).toBe(2);
    expect(submit.mock.calls[0]?.[0].body).toBe('人工合并A+B');
  });
  it('dirty input cancels application update refresh', () => {
    const view = render(
      <EntryEditor
        mode="create"
        submitting={false}
        error={null}
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(window.dispatchEvent(new Event('aiwb:before-refresh', { cancelable: true }))).toBe(true);
    fireEvent.change(screen.getByTestId('entry-body'), { target: { value: '输入中' } });
    expect(window.dispatchEvent(new Event('aiwb:before-refresh', { cancelable: true }))).toBe(
      false,
    );
    view.unmount();
    expect(window.dispatchEvent(new Event('aiwb:before-refresh', { cancelable: true }))).toBe(true);
  });
  it('polls visible pages every30s with bounded error backoff and stops hidden', () => {
    const spy = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    expect(activeRefreshInterval({ state: { status: 'success', errorUpdateCount: 0 } })).toBe(
      30000,
    );
    expect(activeRefreshInterval({ state: { status: 'error', errorUpdateCount: 2 } })).toBe(120000);
    expect(activeRefreshInterval({ state: { status: 'error', errorUpdateCount: 99 } })).toBe(
      300000,
    );
    spy.mockReturnValue('hidden');
    expect(activeRefreshInterval({ state: { status: 'success', errorUpdateCount: 0 } })).toBe(
      false,
    );
    spy.mockRestore();
  });
});
