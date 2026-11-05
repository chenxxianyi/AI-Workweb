import { mkdir, statfs } from 'node:fs/promises';
import { ApiException } from './api-exception.js';
import { logger } from './logger.js';
export function classifyDisk(available: number, total: number) {
  const ratio = total > 0 ? available / total : 0;
  return { ratio, status: ratio < 0.1 ? 'critical' : ratio < 0.2 ? 'warning' : 'ok' } as const;
}
export async function requireTransferCapacity(directory: string, requiredBytes = 0) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await statfs(directory),
    available = info.bavail * info.bsize,
    total = info.blocks * info.bsize,
    result = classifyDisk(available - requiredBytes, total);
  if (result.status !== 'ok')
    logger.warn({ diskStatus: result.status, freeRatio: result.ratio }, 'transfer_disk_capacity');
  if (result.status === 'critical')
    throw new ApiException(
      'SERVICE_UNAVAILABLE',
      '本机磁盘余量不足10%，暂停高体积导入导出，请先整理空间',
    );
  return { available, total, ...result };
}
