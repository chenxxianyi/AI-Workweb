/** 领域枚举（与 PostgreSQL 原生枚举、OpenAPI 枚举一致，F03 冻结） */

export const TASK_PRIORITIES = ['p0', 'p1', 'p2'] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export const TASK_STATUSES = ['todo', 'doing', 'done'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const ENTRY_TYPES = ['note', 'design', 'adr', 'troubleshoot', 'command'] as const;
export type EntryType = (typeof ENTRY_TYPES)[number];

export const ENTRY_STATUSES = ['draft', 'verified', 'archived'] as const;
export type EntryStatus = (typeof ENTRY_STATUSES)[number];

export const MEMBER_ROLES = ['owner', 'editor', 'viewer'] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];

export const PROJECT_STAGES = ['planning', 'developing', 'paused', 'done'] as const;
export type ProjectStage = (typeof PROJECT_STAGES)[number];

export const TRANSFER_STATES = [
  'uploaded',
  'validating',
  'preview_ready',
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'expired',
] as const;
export type TransferState = (typeof TRANSFER_STATES)[number];

/** 可编辑实体（带 version，更新需 If-Match） */
export interface Versioned {
  version: number;
}

export interface Timestamps {
  createdAt: string;
  updatedAt: string;
}
