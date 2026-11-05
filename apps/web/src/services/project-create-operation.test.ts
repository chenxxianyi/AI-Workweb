import 'fake-indexeddb/auto';
import { beforeEach, it, expect, vi } from 'vitest';
import { clearPrivateUser } from '../offline/store';
import { saveDraft } from '../offline/queue';
import { ApiError } from './api-client';
import { projectsApi, type Project } from './projects-api';
import { pendingProjectCreate, submitProjectCreate } from './project-create-operation';
vi.mock('./projects-api', () => ({ projectsApi: { create: vi.fn() } }));
const input = { name: '断线项目', nextStep: '确认原提交' },
  result = { id: 'created-project' } as Project;
it('concurrent tabs reserve one durable key', async () => {
  await clearPrivateUser('project-owner');
  vi.mocked(projectsApi.create).mockRejectedValue(
    new ApiError({ kind: 'network', message: '未知' }),
  );
  await Promise.allSettled([
    submitProjectCreate('project-owner', 'space', input),
    submitProjectCreate('project-owner', 'space', input),
  ]);
  const calls = vi.mocked(projectsApi.create).mock.calls;
  expect(calls).toHaveLength(2);
  expect(calls[0]?.[2]).toBe(calls[1]?.[2]);
});
beforeEach(async () => {
  vi.resetAllMocks();
  await clearPrivateUser('project-owner');
});
it('persists original body/key across response loss and a new invocation, then clears only after success', async () => {
  vi.mocked(projectsApi.create)
    .mockRejectedValueOnce(new ApiError({ kind: 'network', message: '响应丢失' }))
    .mockResolvedValueOnce(result);
  await expect(submitProjectCreate('project-owner', 'space', input)).rejects.toThrow();
  const saved = await pendingProjectCreate('project-owner', 'space');
  expect(saved?.input).toEqual(input);
  await submitProjectCreate('project-owner', 'space', input);
  expect(vi.mocked(projectsApi.create).mock.calls[0]?.[2]).toBe(
    vi.mocked(projectsApi.create).mock.calls[1]?.[2],
  );
  expect(await pendingProjectCreate('project-owner', 'space')).toBeNull();
});
it('blocks changed content and isolates account/workspace while result is unknown', async () => {
  vi.mocked(projectsApi.create).mockRejectedValue(
    new ApiError({ kind: 'timeout', message: '未知' }),
  );
  await expect(submitProjectCreate('project-owner', 'space', input)).rejects.toThrow();
  await expect(
    submitProjectCreate('project-owner', 'space', { name: '另一个项目' }),
  ).rejects.toThrow('原内容');
  expect(projectsApi.create).toHaveBeenCalledTimes(1);
  expect(await pendingProjectCreate('other', 'space')).toBeNull();
  expect(await pendingProjectCreate('project-owner', 'other-space')).toBeNull();
});
it('never resends after retention expires and leaves the record available for export', async () => {
  await saveDraft('project-owner', 'space', 'project-create-pending', {
    key: 'old-key',
    createdAt: Date.now() - 8 * 86400000,
    input,
  });
  await expect(submitProjectCreate('project-owner', 'space', input)).rejects.toThrow('7天');
  expect(projectsApi.create).not.toHaveBeenCalled();
  expect(await pendingProjectCreate('project-owner', 'space')).not.toBeNull();
});
it('known first validation rejection permits a corrected new attempt', async () => {
  vi.mocked(projectsApi.create)
    .mockRejectedValueOnce(new ApiError({ kind: 'http', status: 422, message: '字段错误' }))
    .mockResolvedValueOnce(result);
  await expect(submitProjectCreate('project-owner', 'space', input)).rejects.toThrow();
  expect(await pendingProjectCreate('project-owner', 'space')).toBeNull();
  await submitProjectCreate('project-owner', 'space', { name: '修正项目' });
  expect(vi.mocked(projectsApi.create).mock.calls[0]?.[2]).not.toBe(
    vi.mocked(projectsApi.create).mock.calls[1]?.[2],
  );
});
