import { NextRequest, NextResponse } from 'next/server';

import { badRequest, errorResponse, notFound, serverError } from '@/lib/errors';
import {
  SubjectRepoError,
  getSubjectRepository,
} from '@/lib/subjects/repository';
import { validateMergeInput } from '@/lib/subjects/validator';

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest('request body must be valid JSON');
  }

  const parsed = validateMergeInput(body);
  if (!parsed.ok) {
    return badRequest(parsed.error.message);
  }

  try {
    const repo = getSubjectRepository();
    const result = repo.merge(parsed.value);
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
