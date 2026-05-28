import { NextRequest, NextResponse } from 'next/server';

import { badRequest, errorResponse, notFound, serverError } from '@/lib/errors';
import { SubjectRepoError } from '@/lib/subjects/repository';
import { getSubjectAliasRepository } from '@/lib/subjects/alias-repository';

interface AliasRequestBody {
  subject_id?: unknown;
  alias?: unknown;
  alias_id?: unknown;
}

export async function GET(request: NextRequest) {
  const subjectId = request.nextUrl.searchParams.get('subject_id');
  if (!subjectId) {
    return badRequest('subject_id is required');
  }

  try {
    const aliases = getSubjectAliasRepository().list(subjectId);
    return NextResponse.json({
      data: aliases,
      meta: { total: aliases.length, page: 1, pageSize: aliases.length },
    });
  } catch (err) {
    if (err instanceof SubjectRepoError) return mapRepoError(err);
    return serverError(err instanceof Error ? err.message : 'Unknown error');
  }
}

export async function POST(request: NextRequest) {
  let body: AliasRequestBody;
  try {
    body = await request.json();
  } catch {
    return badRequest('request body must be valid JSON');
  }

  if (typeof body.subject_id !== 'string' || !body.subject_id.trim()) {
    return badRequest('subject_id is required');
  }
  if (typeof body.alias !== 'string') {
    return badRequest('alias is required');
  }

  try {
    const alias = getSubjectAliasRepository().create(body.subject_id.trim(), body.alias);
    return NextResponse.json({ data: alias }, { status: 201 });
  } catch (err) {
    if (err instanceof SubjectRepoError) return mapRepoError(err);
    return serverError(err instanceof Error ? err.message : 'Unknown error');
  }
}

export async function DELETE(request: NextRequest) {
  let body: AliasRequestBody;
  try {
    body = await request.json();
  } catch {
    return badRequest('request body must be valid JSON');
  }

  if (typeof body.subject_id !== 'string' || !body.subject_id.trim()) {
    return badRequest('subject_id is required');
  }
  if (typeof body.alias_id !== 'string' || !body.alias_id.trim()) {
    return badRequest('alias_id is required');
  }

  try {
    const removed = getSubjectAliasRepository().remove(
      body.subject_id.trim(),
      body.alias_id.trim(),
    );
    return NextResponse.json({ data: { ...removed, deleted: true } });
  } catch (err) {
    if (err instanceof SubjectRepoError) return mapRepoError(err);
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
