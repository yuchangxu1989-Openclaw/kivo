/**
 * GET  /api/classify/threshold — 返回当前分类置信度阈值
 * POST /api/classify/threshold — 更新阈值（范围校验 + 写库 + 写 history）
 *
 * KIVO Wave 1 C3 — spec FR-CLASSIFY-2 / FR-CONFIG-1
 * AC: AC-THRESHOLD-1.1, AC-THRESHOLD-1.2, AC-THRESHOLD-1.3
 */

import { NextRequest, NextResponse } from 'next/server';

import { badRequest, serverError } from '@/lib/errors';
import {
  getThreshold,
  setThreshold,
  validateThreshold,
  THRESHOLD_MIN,
  THRESHOLD_MAX,
} from '@/lib/classify/threshold-store';

// ─── GET ─────────────────────────────────────────────────────────────────────

export async function GET() {
  try {
    const record = getThreshold();
    return NextResponse.json({
      threshold: record.threshold,
      updated_at: record.updated_at,
    });
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Unknown error');
  }
}

// ─── POST ────────────────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest('request body must be valid JSON');
  }

  if (!body || typeof body !== 'object') {
    return badRequest('request body must be a JSON object');
  }

  const { threshold } = body as { threshold?: unknown };
  const validation = validateThreshold(threshold);

  if (!validation.ok) {
    return badRequest(validation.error, {
      min: THRESHOLD_MIN,
      max: THRESHOLD_MAX,
    });
  }

  try {
    const record = setThreshold(validation.value);
    return NextResponse.json({
      threshold: record.threshold,
      updated_at: record.updated_at,
    });
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Unknown error');
  }
}
