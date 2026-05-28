/**
 * POST /api/subjects/[id]/merge
 *
 * KIVO Wave 1 B2 — see spec FR-B03 (学科域分类管线 rename + merge).
 *
 * Body: { target_id: string } | { targetId: string }
 *
 * Effect:
 *   - Re-parents every direct child of `:id` (the source) under
 *     `target_id` (the target).
 *   - Re-points every material whose `subject_node_id = :id` to
 *     `target_id`.
 *   - Sets `merged_into = target_id` on the source so the existing
 *     `merged_into IS NULL` filter (added in B1) hides it from list /
 *     CRUD reads automatically.
 *
 * Errors:
 *   - 400 BAD_REQUEST — `target_id` missing, source = target, level
 *     mismatch, or target is a descendant of source.
 *   - 404 NOT_FOUND   — either source or target id does not exist.
 *   - 409 CONFLICT    — source or target has already been merged away.
 */

import { NextRequest, NextResponse } from 'next/server';

import { badRequest, errorResponse, notFound, serverError } from '@/lib/errors';
import {
  SubjectRepoError,
  getSubjectRepository,
} from '@/lib/subjects/repository';
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest('request body must be valid JSON');
  }

  const raw = body as Record<string, unknown>;
  const targetId =
    typeof raw.target_id === 'string'
      ? raw.target_id.trim()
      : typeof raw.targetId === 'string'
        ? raw.targetId.trim()
        : '';
  if (!targetId) {
    return badRequest('target_id is required');
  }

  try {
    const repo = getSubjectRepository();
    const result = repo.merge({
      sourceSubjectIds: [id],
      targetSubjectId: targetId,
    });
    return NextResponse.json({ data: result });
  } catch (err) {
    if (err instanceof SubjectRepoError) {
      return mapRepoError(err);
    }
    return serverError(err instanceof Error ? err.message : 'Unknown error');
  }
}

function mapRepoError(err: SubjectRepoError) {
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
