/**
 * POST /api/subjects/[id]/rename
 *
 * KIVO Wave 1 B2 — see spec FR-B03 (学科域分类管线 rename + merge).
 *
 * Body: { name: string }
 *
 * Behaviour:
 *   - Renames the subject in place.
 *   - Appends the previous name to `aliases.prior_names` so the old
 *     label remains searchable for B5 (alias) and the SubjectClassifier.
 *   - Returns 409 when another sibling under the same parent already
 *     uses the new name.
 *   - Returns 404 when the subject does not exist.
 *   - Returns 409 when the subject has already been merged away.
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
  if (typeof raw.name !== 'string' || raw.name.trim().length === 0) {
    return badRequest('name must be a non-empty string');
  }

  try {
    const repo = getSubjectRepository();
    const updated = repo.rename({ subjectId: id, newName: raw.name.trim() });
    return NextResponse.json({ data: updated });
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
