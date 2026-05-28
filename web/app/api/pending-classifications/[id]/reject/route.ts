/**
 * POST /api/pending-classifications/[id]/reject — KIVO Wave 1 / C1
 *
 * 用户/Agent 拒绝当前 A2 给出的建议。素材保留在 pending 队列里，
 * classification_status 切回 'pending_classification'，subject_node_id /
 * suggested_subject_name / classification_confidence 全部清空，等下次
 * A2 调度器（A2 task）重新打分。
 *
 * Spec：reports/kivo-wave1-prompt-breakdown-2026-05-24.md §C1 AC-CLASSIFY-3.3。
 */

import { NextRequest, NextResponse } from 'next/server';

import { badRequest, errorResponse, notFound, serverError } from '@/lib/errors';
import {
  PendingRepoError,
  getPendingClassificationsRepository,
} from '@/lib/pending-classifications/repository';

export const runtime = 'nodejs';

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!id) return badRequest('material id is required');

  try {
    const repo = getPendingClassificationsRepository();
    const result = repo.reject(id);
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
