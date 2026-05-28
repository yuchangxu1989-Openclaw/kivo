/**
 * GET  /api/subjects — list full subject tree (nested, with material counts)
 * POST /api/subjects — create a subject node
 *
 * KIVO Wave 1 B1 — see spec FR-B03 and
 * reports/kivo-wave1-prompt-breakdown-2026-05-24.md §B1.
 */

import { NextRequest, NextResponse } from 'next/server';

import { badRequest, errorResponse, notFound, serverError } from '@/lib/errors';
import {
  SubjectRepoError,
  getSubjectRepository,
} from '@/lib/subjects/repository';
import { validateCreateInput } from '@/lib/subjects/validator';
import type { ApiResponse } from '@/types';
import type { SubjectNode, SubjectTreeNode } from '@/lib/types/subject';

export async function GET() {
  try {
    const repo = getSubjectRepository();
    const tree = repo.listTree();
    const total = countTreeNodes(tree);
    const response: ApiResponse<SubjectTreeNode[]> = {
      data: tree,
      meta: { total, page: 1, pageSize: total },
    };
    return NextResponse.json(response);
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Unknown error');
  }
}

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest('request body must be valid JSON');
  }

  const parsed = validateCreateInput(body);
  if (!parsed.ok) {
    return badRequest(parsed.error.message);
  }

  try {
    const repo = getSubjectRepository();
    const created: SubjectNode = repo.create(parsed.value);
    return NextResponse.json({ data: created }, { status: 201 });
  } catch (err) {
    if (err instanceof SubjectRepoError) {
      return mapRepoError(err);
    }
    return serverError(err instanceof Error ? err.message : 'Unknown error');
  }
}

function countTreeNodes(tree: SubjectTreeNode[]): number {
  let n = 0;
  const walk = (nodes: SubjectTreeNode[]) => {
    for (const node of nodes) {
      n += 1;
      if (node.children.length) walk(node.children);
    }
  };
  walk(tree);
  return n;
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
