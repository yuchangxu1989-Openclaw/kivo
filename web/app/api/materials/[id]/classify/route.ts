/**
 * POST /api/materials/[id]/classify — Wave 1 / A2 单条分类触发
 *
 * 接收单条 material id，调用 classifier 跑 LLM 分类并落库。响应：
 *   - 成功 200 { data: { materialId, status, subjectNodeId, confidence, ... } }
 *   - material 不存在 404
 *   - LLM 失败 502（携带 status='failed' 的 details）
 */

import { NextRequest, NextResponse } from 'next/server';

import { classifySingle } from '@/lib/materials/classifier';
import { errorResponse, notFound, serverError } from '@/lib/errors';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  const id = params?.id?.trim();
  if (!id) {
    return errorResponse('BAD_REQUEST', 'material id is required', 400);
  }

  try {
    const result = await classifySingle(id);
    if (result.status === 'failed') {
      // material 不存在 → 404；其他失败 → 502 (LLM/上游故障)
      if (result.error?.includes('not found')) {
        return notFound(result.error);
      }
      return errorResponse('CLASSIFY_FAILED', result.error || 'classify failed', 502, result);
    }
    return NextResponse.json({ data: result });
  } catch (err) {
    return serverError((err as Error).message);
  }
}
