/**
 * POST /api/pending/reject — KIVO Wave 1 / C1
 *
 * 用户拒绝当前 A2 给出的候选 subject。entry 留在 pending 队列里
 * （classification_status='pending_classification'），并把候选 +
 * 拒绝原因写入 personal_state 作为用户偏好。
 *
 * Body: { entry_id: string, candidate_subject_id?: string, reason?: string }
 *
 * 行为：
 *   - entry 不存在 → 404
 *   - candidate 显式指定但不存在 → 400
 *   - entry 已 classified → 409
 *   - 无候选时仍可拒绝（personal_state 仅记录 reason）
 *
 * Spec：FR-CLASSIFY-3.3。
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

interface RejectInput {
  entry_id?: unknown;
  candidate_subject_id?: unknown;
  reason?: unknown;
}

export async function POST(request: NextRequest) {
  let body: RejectInput;
  try {
    body = (await request.json()) as RejectInput;
  } catch {
    return badRequest('request body must be valid JSON');
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return badRequest('request body must be a JSON object');
  }

  const entryId = normalizeStr(body.entry_id);
  if (!entryId) return badRequest('entry_id is required');

  const candidateRaw = body.candidate_subject_id;
  let candidateSubjectId: string | undefined;
  if (candidateRaw !== undefined && candidateRaw !== null) {
    const v = normalizeStr(candidateRaw);
    if (!v) return badRequest('candidate_subject_id must be a non-empty string when provided');
    candidateSubjectId = v;
  }

  const reasonRaw = body.reason;
  let reason: string | undefined;
  if (reasonRaw !== undefined && reasonRaw !== null) {
    if (typeof reasonRaw !== 'string') return badRequest('reason must be a string');
    const trimmed = reasonRaw.trim();
    if (trimmed.length > 0) reason = trimmed;
  }

  try {
    const repo = getPendingRepository();
    const result = repo.reject(entryId, candidateSubjectId, reason);
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
