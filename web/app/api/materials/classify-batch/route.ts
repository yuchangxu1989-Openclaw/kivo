/**
 * POST /api/materials/classify-batch — Wave 1 / A2 批量分类触发
 *
 * 扫 materials.classification_status='pending'，串行跑分类，最多 max
 * 条。Body 可选 { max?: number }，缺省 20，硬上限 20。
 *
 * 响应：
 *   200 { data: { processed, classified, pending, failed, results: [...] } }
 */

import { NextRequest, NextResponse } from 'next/server';

import { classifyBatch } from '@/lib/materials/classifier';
import { badRequest, serverError } from '@/lib/errors';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface BatchBody {
  max?: number;
}

export async function POST(req: NextRequest) {
  let body: BatchBody = {};
  if (req.headers.get('content-length') && req.headers.get('content-length') !== '0') {
    try {
      body = (await req.json()) as BatchBody;
    } catch {
      // 允许空 body / 非法 JSON → 视作 default max
      body = {};
    }
  }

  const max = body.max;
  if (max != null && (!Number.isFinite(max) || max <= 0)) {
    return badRequest('max must be a positive number');
  }

  try {
    const result = await classifyBatch(max ?? 20);
    return NextResponse.json({ data: result });
  } catch (err) {
    return serverError((err as Error).message);
  }
}
