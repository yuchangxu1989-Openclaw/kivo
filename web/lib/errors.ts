/**
 * Shared API error helpers — unified error response format.
 */

import { NextResponse } from 'next/server';
import type { ApiError, VersionConflictError } from '@/types';

export function errorResponse(code: string, message: string, status: number, details?: unknown) {
  const body: ApiError = { error: { code, message, details } };
  return NextResponse.json(body, { status });
}

export function badRequest(message: string, details?: unknown) {
  return errorResponse('BAD_REQUEST', message, 400, details);
}

export function notFound(message: string) {
  return errorResponse('NOT_FOUND', message, 404);
}

export function versionConflict(currentVersion: number, expectedVersion: number, requestId: string) {
  const body: VersionConflictError = {
    error: {
      code: 'VERSION_CONFLICT',
      message: `Version conflict: expected ${expectedVersion}, current is ${currentVersion}`,
      details: { currentVersion, expectedVersion, requestId },
    },
  };
  return NextResponse.json(body, { status: 409 });
}

export function serverError(message: string) {
  return errorResponse('INTERNAL_ERROR', message, 500);
}
