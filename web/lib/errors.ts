/**
 * Shared API error helpers - unified error response format.
 */

import { NextResponse } from 'next/server';
import type { ApiError, VersionConflictError } from '@/types';

const DEFAULT_ERROR_HINTS: Record<string, string> = {
  BAD_REQUEST: '请检查请求参数后重试',
  NOT_FOUND: '请确认资源是否存在，或刷新页面后重试',
  INTERNAL_ERROR: '请稍后重试，若持续出现请联系管理员',
  VERSION_CONFLICT: '请刷新页面获取最新版本后重试',
  CONFLICT: '数据已被其他操作修改，请刷新后重试',
  CLASSIFY_FAILED: '分类服务暂时不可用，请稍后重试',
};

function defaultHint(code: string) {
  return DEFAULT_ERROR_HINTS[code] ?? '请稍后重试或联系支持';
}

export function errorResponse(code: string, message: string, status: number, details?: unknown, hint?: string) {
  const body: ApiError = { error: { code, message, hint: hint ?? defaultHint(code), details } };
  return NextResponse.json(body, { status });
}

export function badRequest(message: string, details?: unknown, hint?: string) {
  return errorResponse('BAD_REQUEST', message, 400, details, hint);
}

export function notFound(message: string, hint?: string) {
  return errorResponse('NOT_FOUND', message, 404, undefined, hint);
}

export function versionConflict(currentVersion: number, expectedVersion: number, requestId: string) {
  const body: VersionConflictError = {
    error: {
      code: 'VERSION_CONFLICT',
      message: `Version conflict: expected ${expectedVersion}, current is ${currentVersion}`,
      details: { currentVersion, expectedVersion, requestId },
      hint: defaultHint('VERSION_CONFLICT'),
    },
  };
  return NextResponse.json(body, { status: 409 });
}

export function serverError(message: string) {
  return errorResponse('INTERNAL_ERROR', message, 500);
}
