/**
 * POST /api/pending-classifications/[id]/confirm — KIVO Wave 1 / C1
 *
 * 用户/Agent 确认将素材归位到某个 subject_node_id。请求体可选传
 * `subjectNodeId` 覆盖 A2 的建议；不传则采纳 materials.subject_node_id
 * 上的现有建议。归位成功后 classification_status = 'classified'，
 * 该素材离开 pending 队列。
 *
 * Spec：reports/kivo-wave1-prompt-breakdown-2026-05-24.md §C1 AC-CLASSIFY-3.2 / 3.4。
 */

import { NextRequest, NextResponse } from 'next/server';

import { badRequest, errorResponse, notFound, serverError } from '@/lib/errors';
import {
  PendingRepoError,
  getPendingClassificationsRepository,
} from '@/lib/pending-classifications/repository';
import type { ConfirmPendingInput } from '@/lib/types/pending-classification';

export const runtime = 'nodejs';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!id) return badRequest('material id is required');

  // Body is optional. Accept empty body, valid JSON object, or {subjectNodeId}.
  let parsed: ConfirmPendingInput = {};
  try {
    const text = await request.text();
    if (text.trim().length > 0) {
      const json = JSON.parse(text) as unknown;
      if (json !== null && typeof json === 'object') {
        const candidate = (json as Record<string, unknown>).subjectNodeId;
        if (candidate !== undefined) {
          if (typeof candidate !== 'string' || candidate.trim().length === 0) {
            return badRequest('subjectNodeId must be a non-empty string when provided');
          }
          parsed = { subjectNodeId: candidate.trim() };
        }
      } else {
        return badRequest('request body must be a JSON object when provided');
      }
    }
  } catch {
    return badRequest('request body must be valid JSON when provided');
  }

  try {
    const repo = getPendingClassificationsRepository();
    const result = repo.confirm(id, parsed.subjectNodeId);
    return NextResponse.json({ data: result });
  } catch (err) {
    if (err instanceof PendingRepoError) {
      return mapRepoError(err);
    }
    return serverError(err instanceof Error ? err.message : 'Unknown error');
  }
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
