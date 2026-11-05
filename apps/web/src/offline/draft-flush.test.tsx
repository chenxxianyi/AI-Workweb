import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { flushActiveDrafts, useDraftFlush } from './draft-flush';
function Editor({ save }: { save: () => Promise<unknown> }) {
  useDraftFlush(true, save);
  return <input aria-label="未提交内容" defaultValue="保留输入" />;
}
it('logout flush waits for current input persistence instead of racing debounce', async () => {
  let finish: () => void = () => {};
  const save = vi.fn(
    () =>
      new Promise<void>((r) => {
        finish = r;
      }),
  );
  render(<Editor save={save} />);
  let done = false;
  const promise = flushActiveDrafts().then(() => {
    done = true;
  });
  expect(save).toHaveBeenCalledOnce();
  expect(done).toBe(false);
  finish();
  await promise;
  expect(done).toBe(true);
});
it('quota error blocks losing local input and leaves exportable value', async () => {
  render(<Editor save={() => Promise.reject(new DOMException('quota', 'QuotaExceededError'))} />);
  fireEvent.change(screen.getByLabelText('未提交内容'), { target: { value: '仍需导出' } });
  await expect(flushActiveDrafts()).rejects.toThrow('先导出');
  expect((screen.getByLabelText('未提交内容') as HTMLInputElement).value).toBe('仍需导出');
});
