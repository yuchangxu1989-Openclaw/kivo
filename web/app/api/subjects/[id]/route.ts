/**
 * GET    /api/subjects/[id] — fetch a single node (with material count)
 * PATCH  /api/subjects/[id] — rename and/or move a node
 * DELETE /api/subjects/[id] — delete a leaf node with no materials
 *
 * KIVO Wave 1 B1 — see spec FR-B03.
 */

import { NextRequest, NextResponse } from 'next/server';

import { badRequest, errorResponse, notFound, serverError } from '@/lib/errors';
import {
  SubjectRepoError,
  getSubjectRepository,
} from '@/lib/subjects/repository';
import { validateUpdateInput } from '@/lib/subjects/validator';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const repo = getSubjectRepository();
    const node = repo.getById(id);
    if (!node) return notFound(`subject ${id} not found`);
    return NextResponse.json({ data: node });
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Unknown error');
  }
}

export async function PATCH(
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

  const parsed = validateUpdateInput(body);
  if (!parsed.ok) {
    return badRequest(parsed.error.message);
  }

  try {
    const repo = getSubjectRepository();
    const updated = repo.update(id, parsed.value);
    return NextResponse.json({ data: updated });
  } catch (err) {
    if (err instanceof SubjectRepoError) {
      return mapRepoError(err);
    }
    return serverError(err instanceof Error ? err.message : 'Unknown error');
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    const repo = getSubjectRepository();
    repo.delete(id);
    return NextResponse.json({ data: { id, deleted: true } });
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
