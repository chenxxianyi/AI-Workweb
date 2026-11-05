import { Injectable, type PipeTransform } from '@nestjs/common';
import type { ZodError} from 'zod';
import { type ZodType } from 'zod';
import type { FieldErrors } from '@aiwb/contracts';
import { ApiException } from './api-exception.js';

/** 把 zod 的 issues 转成契约里的 fieldErrors（字段路径，不用数据库列名） */
export function toFieldErrors(error: ZodError): FieldErrors {
  const fieldErrors: FieldErrors = {};
  const push = (path: string, message: string): void => {
    const list = fieldErrors[path] ?? (fieldErrors[path] = []);
    list.push(message);
  };
  for (const issue of error.issues) {
    // zod v4 对 strictObject 的未知字段使用 unrecognized_keys，path 为空但带 keys
    if (issue.code === 'unrecognized_keys') {
      const keys = (issue as { keys?: string[] }).keys ?? [];
      for (const key of keys) push(key, '不允许的字段');
      continue;
    }
    push(issue.path.length === 0 ? '_' : issue.path.join('.'), issue.message);
  }
  return fieldErrors;
}

/**
 * zod 校验管道（F06）。
 * 用法：`@Body(new ZodPipe(createTaskSchema)) dto: CreateTaskDto`
 * - 失败统一 422 VALIDATION_FAILED + fieldErrors
 * - 未知字段由 schema 的 `z.strictObject` 拒绝（DTO 不使用 passthrough）
 */
@Injectable()
export class ZodPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new ApiException('VALIDATION_FAILED', '请求字段校验失败', {
        fieldErrors: toFieldErrors(result.error),
      });
    }
    return result.data;
  }
}
