import { describe, expect, it } from 'vitest';
import { ERROR_CODES, ERROR_STATUS } from './error-codes';
import { ERROR_STATUS as STATUS_FROM_INDEX } from './index';
import { etagFor, isApiError, parseEtag, type ApiResponse } from './envelope';

describe('错误码', () => {
  it('28 个错误码且唯一', () => {
    expect(ERROR_CODES).toHaveLength(28);
    expect(new Set(ERROR_CODES).size).toBe(28);
  });

  it('每个错误码都有合法状态码', () => {
    for (const code of ERROR_CODES) {
      const status = ERROR_STATUS[code];
      expect(status, code).toBeGreaterThanOrEqual(400);
      expect(status, code).toBeLessThanOrEqual(503);
    }
  });

  it('401 只用于认证类错误，403 用于授权类错误', () => {
    expect(ERROR_STATUS.UNAUTHENTICATED).toBe(401);
    expect(ERROR_STATUS.SESSION_EXPIRED).toBe(401);
    expect(ERROR_STATUS.AUTH_INVALID_CREDENTIALS).toBe(401);
    expect(ERROR_STATUS.FORBIDDEN).toBe(403);
    expect(ERROR_STATUS.CSRF_INVALID).toBe(403);
  });

  it('导出入口与错误码定义一致', () => {
    expect(STATUS_FROM_INDEX).toEqual(ERROR_STATUS);
  });
});

describe('响应封装', () => {
  it('isApiError 区分成功与失败', () => {
    const success: ApiResponse<{ id: string }> = {
      data: { id: 'a1' },
      requestId: 'r-1',
    };
    const failure: ApiResponse<{ id: string }> = {
      error: { code: 'NOT_FOUND', message: '不存在' },
      requestId: 'r-2',
    };
    expect(isApiError(success)).toBe(false);
    expect(isApiError(failure)).toBe(true);
  });

  it('ETag 与 version 往返一致', () => {
    expect(etagFor(7)).toBe('"7"');
    expect(parseEtag('"7"')).toBe(7);
    expect(parseEtag('7')).toBe(7);
  });

  it('非法 ETag 返回 null（调用方按 428 处理）', () => {
    expect(parseEtag(null)).toBeNull();
    expect(parseEtag('')).toBeNull();
    expect(parseEtag('abc')).toBeNull();
    expect(parseEtag('"0"')).toBeNull();
    expect(parseEtag('"-3"')).toBeNull();
  });
});
