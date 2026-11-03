import { useState } from 'react';
import { ApiError } from '../../services/api-client';
import { describeApiError } from '../../services/auth-api';
import {
  STAGE_OPTIONS,
  stackInputToArray,
  type Project,
  type ProjectInput,
  type ProjectStage,
} from '../../services/projects-api';
import styles from './projects.module.css';

interface ProjectFormProps {
  mode: 'create' | 'edit';
  initial?: Project;
  submitting: boolean;
  error: unknown;
  onSubmit: (input: ProjectInput) => void;
  onCancel: () => void;
}

/**
 * 项目表单（F13）：创建与编辑复用。
 * 客户端校验只做即时提示，最终以服务端 422 为准（服务端是唯一边界）。
 */
export function ProjectForm({
  mode,
  initial,
  submitting,
  error,
  onSubmit,
  onCancel,
}: ProjectFormProps): React.JSX.Element {
  const [name, setName] = useState(initial?.name ?? '');
  const [repo, setRepo] = useState(initial?.repo ?? '');
  const [stack, setStack] = useState((initial?.stack ?? []).join(', '));
  const [stage, setStage] = useState<ProjectStage>(initial?.stage ?? 'planning');
  const [nextStep, setNextStep] = useState(initial?.nextStep ?? '');
  const [manual, setManual] = useState(initial?.progressMode === 'manual');
  const [manualProgress, setManualProgress] = useState(String(initial?.manualProgress ?? 0));
  const [localError, setLocalError] = useState<string | null>(null);

  const fieldErrors =
    error instanceof ApiError && error.fieldErrors !== undefined
      ? Object.entries(error.fieldErrors).map(([field, messages]) => `${field}：${messages.join('、')}`)
      : [];

  const submit = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setLocalError(null);

    if (name.trim() === '') {
      setLocalError('请填写项目名称');
      return;
    }
    if (nextStep.includes('\n')) {
      setLocalError('“下一步”需为单行文本');
      return;
    }
    const manualValue = Number(manualProgress);
    if (manual && (!Number.isInteger(manualValue) || manualValue < 0 || manualValue > 100)) {
      setLocalError('手动进度需为 0～100 的整数');
      return;
    }

    onSubmit({
      name: name.trim(),
      repo: repo.trim() === '' ? null : repo.trim(),
      stack: stackInputToArray(stack),
      stage,
      nextStep: nextStep.trim(),
      progressManual: manual,
      manualProgress: manual ? manualValue : null,
    });
  };

  return (
    <form className={styles.form} onSubmit={submit} noValidate>
      <div className={styles.grid2}>
        <label className={styles.field}>
          <span className={styles.label}>项目名称 *</span>
          <input
            className={styles.input}
            value={name}
            maxLength={100}
            onChange={(event) => setName(event.target.value)}
            placeholder="例如：工作台全栈版"
            required
          />
        </label>

        <label className={styles.field}>
          <span className={styles.label}>阶段</span>
          <select
            className={styles.input}
            value={stage}
            onChange={(event) => setStage(event.target.value as ProjectStage)}
          >
            {STAGE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <label className={styles.field}>
        <span className={styles.label}>下一步（单行）</span>
        <input
          className={styles.input}
          value={nextStep}
          maxLength={200}
          onChange={(event) => setNextStep(event.target.value)}
          placeholder="只写一个可执行的下一步"
        />
      </label>

      <div className={styles.grid2}>
        <label className={styles.field}>
          <span className={styles.label}>仓库（可选）</span>
          <input
            className={styles.input}
            value={repo}
            onChange={(event) => setRepo(event.target.value)}
            placeholder="https://… 或 owner/name"
          />
        </label>

        <label className={styles.field}>
          <span className={styles.label}>技术栈（逗号分隔，最多 10 项）</span>
          <input
            className={styles.input}
            value={stack}
            onChange={(event) => setStack(event.target.value)}
            placeholder="React, NestJS, PostgreSQL"
          />
        </label>
      </div>

      <fieldset className={styles.fieldset}>
        <legend className={styles.label}>进度</legend>
        <div className={styles.row}>
          <label className={styles.radio}>
            <input type="radio" checked={!manual} onChange={() => setManual(false)} name="progressMode" />
            <span>自动（按任务完成比例）</span>
          </label>
          <label className={styles.radio}>
            <input type="radio" checked={manual} onChange={() => setManual(true)} name="progressMode" />
            <span>手动</span>
          </label>
          {manual ? (
            <label className={styles.inline}>
              <input
                className={styles.inputSmall}
                type="number"
                min={0}
                max={100}
                value={manualProgress}
                onChange={(event) => setManualProgress(event.target.value)}
              />
              <span>%</span>
            </label>
          ) : null}
        </div>
        <p className={styles.hint}>
          手动 0% 是有效值，不会被任务进度覆盖；切回自动后按任务重新计算。
        </p>
      </fieldset>

      {localError === null ? null : (
        <p className={styles.error} role="alert">
          {localError}
        </p>
      )}
      {error === null || error === undefined ? null : (
        <p className={styles.error} role="alert">
          {describeApiError(error)}
          {fieldErrors.length > 0 ? `（${fieldErrors.join('；')}）` : ''}
        </p>
      )}

      <div className={styles.actions}>
        <button type="button" className={styles.secondary} onClick={onCancel} disabled={submitting}>
          取消
        </button>
        <button type="submit" className={styles.primary} disabled={submitting}>
          {submitting ? '保存中…' : mode === 'create' ? '创建项目' : '保存修改'}
        </button>
      </div>
    </form>
  );
}
