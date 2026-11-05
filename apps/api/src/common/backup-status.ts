import { readFile } from 'node:fs/promises';
/** 只返回无敏感路径的运维摘要，业务导出不能代替数据库备份。 */
export async function databaseBackupStatus(): Promise<{ state: string; description: string }> {
  const file = process.env['BACKUP_STATUS_FILE'];
  if (!file)
    return {
      state: 'not_configured',
      description: '尚无数据库备份记录；业务导出与数据库备份分开管理。',
    };
  try {
    const value = JSON.parse(await readFile(file, 'utf8')) as {
      state?: string;
      createdAt?: string;
    };
    if (value.state !== 'ok')
      return { state: 'failed', description: '最近数据库备份失败，请查看本机运维日志。' };
    const at = Date.parse(value.createdAt ?? '');
    if (!Number.isFinite(at) || at > Date.now() + 60000)
      return { state: 'failed', description: '备份记录时间无效，请检查本机运维。' };
    if (Date.now() - at > 86400000)
      return { state: 'stale', description: '数据库备份已超过24小时，请执行备份。' };
    return {
      state: 'ok',
      description:
        '本机加密数据库备份完成；最近 ' +
        new Date(at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
    };
  } catch {
    return { state: 'not_configured', description: '尚无有效数据库备份记录，请执行本机备份。' };
  }
}
