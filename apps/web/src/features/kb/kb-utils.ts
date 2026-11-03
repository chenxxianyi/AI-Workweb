import type { EntryStatus, EntryType } from '../../services/kb-api';

/** 知识库前端辅助（F20） */

export const BODY_LIMIT_BYTES = 20480;

/** 与服务端一致：正文上限按 UTF-8 字节计算（中文 3 字节） */
export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

export function isBodyOverLimit(body: string): boolean {
  return utf8Bytes(body) > BODY_LIMIT_BYTES;
}

/**
 * 单键快捷键只在“非输入态”生效：
 * 在 input/textarea/contenteditable 里打字（例如输入字母 N）不能触发新建弹层。
 */
export function shouldIgnoreShortcut(target: {
  tagName?: string;
  isContentEditable?: boolean;
  type?: string;
}): boolean {
  const tag = (target.tagName ?? '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
  if (target.isContentEditable === true) return true;
  return false;
}

/** Ctrl/Cmd+Enter 保存（Enter 单独按下不保存，避免写长文时误触） */
export function isSaveShortcut(event: { key: string; ctrlKey: boolean; metaKey: boolean }): boolean {
  return event.key === 'Enter' && (event.ctrlKey || event.metaKey);
}

export const STATUS_LABEL: Record<EntryStatus, string> = {
  draft: '草稿',
  verified: '已验证',
  archived: '已归档',
};

export const TYPE_LABEL: Record<EntryType, string> = {
  note: '笔记',
  design: '设计',
  adr: 'ADR',
  troubleshoot: '排错',
  command: '命令',
};

export const TYPE_OPTIONS: { value: EntryType; label: string }[] = [
  { value: 'note', label: '笔记' },
  { value: 'design', label: '设计' },
  { value: 'adr', label: 'ADR' },
  { value: 'troubleshoot', label: '排错' },
  { value: 'command', label: '命令' },
];

/** 状态切换的可选项（与服务端转换表一致） */
export const NEXT_STATUS: Record<EntryStatus, EntryStatus[]> = {
  draft: ['verified', 'archived'],
  verified: ['draft', 'archived'],
  archived: ['draft'],
};
