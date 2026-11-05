import { useState, useEffect, useRef } from 'react';
import { useContentTiming } from '../../services/content-timing';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { EmptyState, ErrorState, LoadingState, Notice, PageHeader } from '../../components/states';
import { useWorkspace } from '../../providers/workspace-provider';
import { describeApiError } from '../../services/auth-api';
import { queryKeys } from '../../services/query-keys';
import {
  STAGE_LABEL,
  progressLabel,
  projectsApi,
  taskSummary,
  type Project,
  type ProjectFilter,
  type ProjectInput,
} from '../../services/projects-api';
import { ProjectForm } from './project-form';
import { useAuth } from '../../providers/auth-provider';
import {
  pendingProjectCreate,
  submitProjectCreate,
  expiredProjectCreate,
  type ProjectCreateOperation,
} from '../../services/project-create-operation';
import { exportLocal } from '../../offline/queue';
import styles from './projects.module.css';

const FILTERS: { value: ProjectFilter; label: string }[] = [
  { value: 'active', label: '进行中' },
  { value: 'inactive', label: '7 天无活动' },
  { value: 'archived', label: '已归档' },
];

/**
 * 项目雷达（F13）：真实接口数据，无 Mock。
 * - 卡片展示阶段、技术栈、下一步、进度（自动/手动）与无活动标记
 * - 创建/编辑走真实 API，失败保留输入并显示原因
 */
export function ProjectsPage(): React.JSX.Element {
  const { workspace, can } = useWorkspace();
  const workspaceId = workspace?.workspaceId ?? '';
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const [filter, setFilter] = useState<ProjectFilter>('active');
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState<unknown>(null);
  const { user } = useAuth(),
    scope = (user?.id ?? '') + ':' + workspaceId;
  const [loadedScope, setLoadedScope] = useState(''),
    [pending, setPending] = useState<ProjectCreateOperation | null>(null);
  const activePending = loadedScope === scope ? pending : null;
  const currentScope = useRef(scope);
  currentScope.current = scope;
  useEffect(() => {
    let active = true;
    if (!user) return;
    void pendingProjectCreate(user.id, workspaceId)
      .then((value) => {
        if (active) {
          setPending(value);
          setLoadedScope(scope);
        }
      })
      .catch((error) => {
        if (active) {
          setFormError(error);
          setLoadedScope(scope);
        }
      });
    return () => {
      active = false;
    };
  }, [user?.id, workspaceId, scope]);

  const listQuery = useQuery({
    queryKey: [...queryKeys.projects(workspaceId, { filter, q: search })] as const,
    queryFn: ({ signal }) =>
      projectsApi.list(workspaceId, { filter, q: search, limit: 50, signal }),
    enabled: workspaceId !== '',
  });

  const createMutation = useMutation({
    onMutate: () => ({ scope }),
    mutationFn: (input: ProjectInput) => {
      if (!user) throw Error('请先登录');
      return submitProjectCreate(user.id, workspaceId, input);
    },
    onSuccess: (_result, _input, context) => {
      if (context?.scope !== currentScope.current) return;
      setCreating(false);
      setPending(null);
      setFormError(null);
      void queryClient.invalidateQueries({ queryKey: ['ws', workspaceId, 'projects'] });
    },
    onError: (error, _input, context) => {
      if (context?.scope !== currentScope.current) return;
      setFormError(error);
      if (user)
        void pendingProjectCreate(user.id, workspaceId)
          .then((value) => {
            if (currentScope.current === context.scope) setPending(value);
          })
          .catch((error) => {
            if (currentScope.current === context.scope) setFormError(error);
          });
    },
  });

  const projects = listQuery.data?.projects ?? [];
  useContentTiming(listQuery.isSuccess);
  const writable = can('business.write');

  return (
    <>
      <PageHeader
        title="项目雷达"
        description="每个项目只保留一个“下一步”；进度可按任务自动计算，也可手动指定（0% 有效）。"
        actions={
          writable ? (
            <button
              type="button"
              className={styles.primary}
              disabled={loadedScope !== scope || !!activePending}
              onClick={() => {
                setFormError(null);
                setCreating((current) => !current);
              }}
            >
              {creating ? '收起表单' : '+ 新建项目'}
            </button>
          ) : (
            <span className={styles.readonlyHint}>只读角色，不能创建或编辑项目</span>
          )
        }
      />

      {activePending ? (
        <section className={styles.panel} aria-label="待确认的项目创建">
          <h2>确认上次项目创建</h2>
          <p>
            原项目：{activePending.input.name}。使用原内容与原幂等键确认；不会重复新建。
            {expiredProjectCreate(activePending) ? '记录超过7天，请先导出并人工核对。' : ''}
          </p>
          <button
            disabled={createMutation.isPending || expiredProjectCreate(activePending)}
            onClick={() => createMutation.mutate(activePending.input)}
          >
            用原内容确认创建
          </button>
          <button onClick={() => exportLocal(activePending, '待确认项目创建.json')}>
            导出原提交记录
          </button>
          {formError ? <p role="alert">{describeApiError(formError)}</p> : null}
        </section>
      ) : null}
      {creating && !activePending ? (
        <section className={styles.panel} aria-label="新建项目">
          <h2 className={styles.panelTitle}>新建项目</h2>
          <ProjectForm
            mode="create"
            submitting={createMutation.isPending}
            error={formError}
            onSubmit={(input) => createMutation.mutate(input)}
            onCancel={() => setCreating(false)}
          />
        </section>
      ) : null}

      <div className={styles.toolbar}>
        <div className={styles.tabs} role="tablist" aria-label="项目筛选">
          {FILTERS.map((item) => (
            <button
              key={item.value}
              type="button"
              role="tab"
              aria-selected={filter === item.value}
              className={filter === item.value ? `${styles.tab} ${styles.tabActive}` : styles.tab}
              onClick={() => setFilter(item.value)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <label className={styles.search}>
          <span className="sr-only">搜索项目名称</span>
          <input
            className={styles.input}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="搜索项目名称"
          />
        </label>
      </div>

      {listQuery.status === 'pending' ? <LoadingState label="加载项目…" /> : null}
      {listQuery.status === 'error' ? (
        <ErrorState
          message={describeApiError(listQuery.error)}
          onRetry={() => {
            void listQuery.refetch();
          }}
        />
      ) : null}

      {listQuery.status === 'success' && projects.length === 0 ? (
        <EmptyState
          title={
            filter === 'archived'
              ? '还没有归档项目'
              : filter === 'inactive'
                ? '没有 7 天无活动的项目'
                : '还没有项目'
          }
          description={
            filter === 'active'
              ? '新建一个项目，写下下一步；在项目详情查看关联任务、知识与台账。'
              : '切换筛选条件可以查看其他项目。'
          }
          action={
            writable && filter === 'active' ? (
              <button type="button" className={styles.primary} onClick={() => setCreating(true)}>
                新建项目
              </button>
            ) : null
          }
        />
      ) : null}

      {projects.length > 0 ? (
        <ul className={styles.grid} aria-label="项目列表">
          {projects.map((project) => (
            <ProjectCard
              key={project.id}
              project={project}
              onOpen={() => navigate(`/projects/${project.id}`)}
            />
          ))}
        </ul>
      ) : null}

      <div style={{ marginTop: 'var(--space-4)' }}>
        <Notice>打开项目详情，查看任务、知识、台账与进度。</Notice>
      </div>
    </>
  );
}

function ProjectCard({
  project,
  onOpen,
}: {
  project: Project;
  onOpen: () => void;
}): React.JSX.Element {
  return (
    <li className={styles.card}>
      <div className={styles.cardHead}>
        <button type="button" className={styles.cardTitle} onClick={onOpen}>
          {project.name}
        </button>
        <span className={styles.stage}>{STAGE_LABEL[project.stage]}</span>
      </div>

      <div className={styles.badges}>
        {project.archived ? <span className={styles.badgeMuted}>已归档</span> : null}
        {project.inactive && !project.archived ? (
          <span className={styles.badgeWarn}>{project.inactiveDays} 天无活动</span>
        ) : null}
      </div>

      {project.stack.length > 0 ? (
        <p className={styles.stack}>{project.stack.join(' · ')}</p>
      ) : (
        <p className={styles.stackMuted}>未填写技术栈</p>
      )}

      <div className={styles.progressRow}>
        <div
          className={styles.progressTrack}
          role="progressbar"
          aria-valuenow={project.progress}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`${project.name} 进度`}
        >
          <span className={styles.progressFill} style={{ width: `${project.progress}%` }} />
        </div>
        <span className={styles.progressText}>{progressLabel(project)}</span>
      </div>
      <p className={styles.taskSummary}>{taskSummary(project)}</p>

      <p className={styles.nextStep}>
        <span className={styles.nextStepLabel}>下一步</span>
        {project.nextStep === '' ? (
          <span className={styles.stackMuted}>未填写</span>
        ) : (
          project.nextStep
        )}
      </p>

      <Link className={styles.cardLink} to={`/projects/${project.id}`}>
        查看详情
      </Link>
    </li>
  );
}
