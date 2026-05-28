/**
 * GET /api/pending/list — KIVO Wave 1 / C1
 *
 * 拉取 pending 队列（materials 表中 classification_status ∈
 * {pending, in_progress, needs_review, pending_classification}）。
 *
 * Query params:
 *   - page (default 1)
 *   - pageSize (default 20, capped 200)
 *   - subject_hint (模糊匹配 suggested_subject_name 或 subject_node 名)
 *   - source (精确匹配 source_channel)
 *
 * 鉴权：依赖 middleware 校验 kivo_session cookie。
 */

import { NextRequest, NextResponse } from 'next/server';

import { badRequest, serverError } from '@/lib/errors';
import { getPendingRepository } from '@/lib/pending/repository';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;

  const page = parseIntParam(sp.get('page'), 1);
  if (page === null) return badRequest('page must be a positive integer');

  const pageSize = parseIntParam(sp.get('pageSize'), 20);
  if (pageSize === null) return badRequest('pageSize must be a positive integer');

  const subjectHint = sp.get('subject_hint') ?? undefined;
  const source = sp.get('source') ?? undefined;

  try {
    const repo = getPendingRepository();
    const result = repo.list({
      page,
      pageSize,
      subjectHint,
      source,
    });

    return NextResponse.json({
      data: result.items,
      meta: {
        total: result.total,
        page: result.page,
        pageSize: result.pageSize,
      },
    });
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Unknown error');
  }
}

function parseIntParam(raw: string | null, fallback: number): number | null {
  if (raw === null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) return null;
  return n;
}
