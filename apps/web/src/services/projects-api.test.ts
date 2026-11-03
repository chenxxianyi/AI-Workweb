import { describe, expect, it } from 'vitest';
import { progressLabel, stackInputToArray, taskSummary, STAGE_LABEL } from './projects-api';

describe('项目展示辅助（F13）', () => {
  it('进度文案区分自动与手动，避免 0% 被误读', () => {
    expect(progressLabel({ progressMode: 'auto', progress: 0 })).toBe('0%（自动）');
    expect(progressLabel({ progressMode: 'manual', progress: 0 })).toBe('0%（手动）');
    expect(progressLabel({ progressMode: 'auto', progress: 33 })).toBe('33%（自动）');
  });

  it('任务摘要：无任务时明确写“暂无任务”', () => {
    expect(taskSummary({ taskCounts: { total: 0, done: 0 } })).toBe('暂无任务');
    expect(taskSummary({ taskCounts: { total: 3, done: 1 } })).toBe('1/3 任务完成');
  });

  it('技术栈输入按中英文逗号拆分并去空', () => {
    expect(stackInputToArray('React, NestJS，PostgreSQL , ')).toEqual(['React', 'NestJS', 'PostgreSQL']);
    expect(stackInputToArray('')).toEqual([]);
  });

  it('阶段中文标签齐全', () => {
    expect(Object.values(STAGE_LABEL)).toEqual(['规划中', '开发中', '暂停', '已完成']);
  });
});
