import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { EmptyState, ErrorState, LoadingState, Notice, PageHeader } from '../../components/states';
import { useWorkspace } from '../../providers/workspace-provider';
import { describeApiError } from '../../services/auth-api';
import {
  STAGE_LABEL,
  progressLabel,
  projectsApi,
  taskSummary,
  type ProjectInput,
} from '../../services/projects-api';
import { ProjectForm } from './project-form';
import styles from './projects.module.css';

/**
 * 项目详情（F13）。
 *
 * - 头部：名称、阶段、进度、下一步；编辑走 If-Match，412 时提示“已被其他设备修改”
 * - 三块关联：任务／知识／台账用 overview 的真实数据；对应模块尚未实现时显示真实空状态
 * - 归档：不删除任务、知识与台账（数据仍在，只是从进行中移出）
 */
export function ProjectDetailPage(): React.JSX.Element {
  const { projectId = '' } = useParams();
  const { workspace, can } = useWorkspace();
  const workspaceId = workspace?.workspaceId ?? '';
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const [editing, setEditing] = useState(false);
  const [editError, setEditError] = useState<unknown>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const overviewQuery = useQuery({
    queryKey: ['ws', workspaceId, 'project', projectId, 'overview'],
    queryFn: ({ signal }) => projectsApi.overview(workspaceId, projectId, { signal }),
    enabled: workspaceId !== '' && projectId !== '',
  });

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['ws', workspaceId, 'project', projectId] });
    void queryClient.invalidateQueries({ queryKey: ['ws', workspaceId, 'projects'] });
  };

  const updateMutation = useMutation({
    mutationFn: (input: ProjectInput) => {
      const project = overviewQuery.data?.project;
      if (project === undefined) throw new Error('项目尚未加载');
      return projectsApi.update(workspaceId, projectId, input, project.version);
    },
    onSuccess: () => {
      setEditing(false);
      setEditError(null);
      invalidate();
    },
    onError: (error) => setEditError(error),
  });

  const archiveMutation = useMutation({
    mutationFn: (archived: boolean) => {
      const project = overviewQuery.data?.project;
      if (project === undefined) throw new Error('项目尚未加载');
      return archived
        ? projectsApi.archive(workspaceId, projectId, project.version)
        : projectsApi.unarchive(workspaceId, projectId, project.version);
    },
    onSuccess: () => invalidate(),
  });

  const deleteMutation = useMutation({
    mutationFn: () => {
      const project = overviewQuery.data?.project;
      if (project === undefined) throw new Error('项目尚未加载');
      return projectsApi.remove(workspaceId, projectId, project.version);
    },
    onSuccess: () => {
      invalidate();
      navigate('/projects', { replace: true });
    },
  });

  if (overviewQuery.status === 'pending') return <LoadingState label="加载项目详情…" />;
  if (overviewQuery.status === 'error') {
    return (
      <ErrorState
        title="无法加载项目"
        message={describeApiError(overviewQuery.error)}
        onRetry={() => {
          void overviewQuery.refetch();
        }}
      />
    );
  }

  const { project, tasks, entries, ledger } = overviewQuery.data;
  const writable = can('business.write');

  return (
    <>
      <p className={styles.breadcrumb}>
        <Link to="/projects">项目雷达</Link> / {project.name}
      </p>

      <PageHeader
        title={project.name}
        description={`${STAGE_LABEL[project.stage]} · ${progressLabel(project)} · ${taskSummary(project)}${
          project.inactive && !project.archived ? ` · ${project.inactiveDays} 天无活动` : ''
        }${project.archived ? ' · 已归档' : ''}`}
        actions={
          writable ? (
            <div className={styles.row}>
              <button type="button" className={styles.secondary} onClick={() => setEditing((value) => !value)}>
                {editing ? '收起编辑' : '编辑'}
              </button>
              <button
                type="button"
                className={styles.secondary}
                onClick={() => archiveMutation.mutate(!project.archived)}
                disabled={archiveMutation.isPending}
              >
                {project.archived ? '取消归档' : '归档'}
              </button>
              <button
                type="button"
                className={styles.danger}
                onClick={() => setConfirmDelete(true)}
                disabled={deleteMutation.isPending}
              >
                删除
              </button>
            </div>
          ) : (
            <span className={styles.readonlyHint}>只读角色</span>
          )
        }
      />

      {project.archived ? (
        <div className={styles.archiveNotice}>
          该项目已归档：任务、知识与台账记录仍然保留，只是不再出现在“进行中”列表。
        </div>
      ) : null}

      {confirmDelete ? (
        <div className={styles.confirm} role="alertdialog" aria-label="确认删除项目">
          <p className={styles.confirmTitle}>删除「{project.name}」？</p>
          <p className={styles.hint}>
            这是软删除（进入回收站），不会删除关联的任务、知识与台账；恢复入口在 F34 提供。
          </p>
          <div className={styles.actions}>
            <button type="button" className={styles.secondary} onClick={() => setConfirmDelete(false)}>
              取消
            </button>
            <button
              type="button"
              className={styles.danger}
              onClick={() => deleteMutation.mutate()}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending ? '删除中…' : '确认删除'}
            </button>
          </div>
        </div>
      ) : null}

      {editing ? (
        <section className={styles.panel} aria-label="编辑项目">
          <h2 className={styles.panelTitle}>编辑项目</h2>
          <ProjectForm
            mode="edit"
            initial={project}
            submitting={updateMutation.isPending}
            error={editError}
            onSubmit={(input) => updateMutation.mutate(input)}
            onCancel={() => {
              setEditing(false);
              setEditError(null);
            }}
          />
        </section>
      ) : null}

      <section className={styles.block} aria-labelledby="project-next-step">
        <h2 id="project-next-step" className={styles.blockTitle}>
          下一步
        </h2>
        <p className={styles.nextStepValue}>{project.nextStep === '' ? '未填写' : project.nextStep}</p>
        {project.repo === null ? null : (
          <p className={styles.meta}>
            仓库：<code>{project.repo}</code>
          </p>
        )}
        {project.stack.length === 0 ? null : <p className={styles.meta}>技术栈：{project.stack.join(' · ')}</p>}
      </section>

      <div className={styles.threeBlocks}>
        <section className={styles.block} aria-labelledby="project-tasks">
          <h2 id="project-tasks" className={styles.blockTitle}>
            关联任务 <span className={styles.count}>{tasks.counts.total}</span>
          </h2>
          {tasks.recent.length === 0 ? (
            <EmptyState
              title="还没有关联任务"
              description="任务模块在 F16 接入；当前是真实空数据，不是占位假数据。"
            />
          ) : (
            <ul className={styles.miniList}>
              {tasks.recent.map((task) => (
                <li key={task.id} className={styles.miniItem}>
                  <span className={styles.priority}>{task.priority.toUpperCase()}</span>
                  <span className={styles.miniTitle}>{task.title}</span>
                  <span className={styles.miniMeta}>{task.status}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className={styles.block} aria-labelledby="project-entries">
          <h2 id="project-entries" className={styles.blockTitle}>
            关联知识
          </h2>
          {entries.recent.length === 0 ? (
            <EmptyState title="还没有关联知识" description="知识库在 F20 接入；当前显示真实空状态。" />
          ) : (
            <ul className={styles.miniList}>
              {entries.recent.map((entry) => (
                <li key={entry.id} className={styles.miniItem}>
                  <span className={styles.miniTitle}>{entry.title}</span>
                  <span className={styles.miniMeta}>{entry.status}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className={styles.block} aria-labelledby="project-ledger">
          <h2 id="project-ledger" className={styles.blockTitle}>
            AI 台账 <span className={styles.count}>{ledger.count}</span>
          </h2>
          {ledger.count === 0 ? (
            <EmptyState title="还没有台账记录" description="台账模块在 F26 接入；当前显示真实空状态。" />
          ) : (
            <>
              <p className={styles.meta}>
                累计 {ledger.totalMinutes} 分钟，节省 {ledger.totalSavedMinutes} 分钟
                {ledger.averageEffect === null ? '' : `，平均效果 ${ledger.averageEffect}`}
              </p>
              <ul className={styles.miniList}>
                {ledger.recent.map((record) => (
                  <li key={record.id} className={styles.miniItem}>
                    <span className={styles.miniTitle}>
                      {record.recordDate} · {record.tool}/{record.scene}
                    </span>
                    <span className={styles.miniMeta}>{record.minutes} 分钟</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      </div>

      <div style={{ marginTop: 'var(--space-4)' }}>
        <Notice>
          当前阶段只展示真实数据：任务／知识／台账列表若为空，是因为对应模块尚未接入，不是加载失败。
        </Notice>
      </div>
    </>
  );
}
