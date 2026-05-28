/**
 * POST /api/pending/accept — KIVO Wave 1 / C1
 *
 * 用户接受候选 subject：把 entry（即 materials 行）归位到 subject_id，
 * 并把 classification_status 置为 'classified'。
 *
 * Body: { entry_id: string, subject_id: string }
 *
 * 行为：
 *   - entry 不存在 → 404
 *   - subject 不存在或已被合并 → 400
 *   - entry 已是 classified → 409（前端可借此刷新陈旧状态）
 *
 * Spec：FR-CLASSIFY-3.2 / 3.4 / 3.5。
 */

import { NextRequest, NextResponse } from 'next/server';

import {
  badRequest,
  errorResponse,
  notFound,
  serverError,
} from '@/lib/errors';
import {
  PendingRepoError,
  getPendingRepository,
} from '@/lib/pending/repository';

export const runtime = 'nodejs';

interface AcceptInput {
  entry_id?: unknown;
  subject_id?: unknown;
}

export async function POST(request: NextRequest) {
  let body: AcceptInput;
  try {
    body = (await request.json()) as AcceptInput;
  } catch {
    return badRequest('request body must be valid JSON');
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return badRequest('request body must be a JSON object');
  }

  const entryId = normalizeStr(body.entry_id);
  if (!entryId) return badRequest('entry_id is required');

  const subjectId = normalizeStr(body.subject_id);
  if (!subjectId) return badRequest('subject_id is required');

  try {
    const repo = getPendingRepository();
    const result = repo.accept(entryId, subjectId);
    return NextResponse.json({ data: result });
  } catch (err) {
    if (err instanceof PendingRepoError) return mapRepoError(err);
    return serverError(err instanceof Error ? err.message : 'Unknown error');
  }
}

function normalizeStr(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function mapRepoError(err: PendingRepoError) {
  switch (err.code) {
    case 'NOT_FOUND':
      return notFound(err.message);
    case 'CONFLICT':
      return errorResponse('CONFLICT', err.message, 409);
    case 'BAD_REQUEST':
    default:
      return badRequest(err.message);
  }
}
