/**
 * POST /api/internal/dispatcher/tick — KIVO Wave 1 / A2
 *
 * 内部 cron 触发端点。每 30 秒由 crontab 调用一次，触发分类管线调度。
 *
 * AC 覆盖：
 *   AC-CLASSIFY-4.2: cron 端点鉴权（无 INTERNAL_TOKEN 返回 401）
 *
 * 鉴权：请求必须携带 Authorization: Bearer <INTERNAL_TOKEN>
 * 或 X-Internal-Token: <INTERNAL_TOKEN>。
 * INTERNAL_TOKEN 从环境变量 KIVO_INTERNAL_TOKEN 读取。
 */

import { NextRequest, NextResponse } from 'next/server';
import { dispatchTick } from '@/lib/queue/dispatcher';

function validateToken(req: NextRequest): boolean {
  const internalToken = process.env.KIVO_INTERNAL_TOKEN || '';
  if (!internalToken) {
    // If no token configured, reject all requests (secure by default)
    return false;
  }

  // Check Authorization: Bearer <token>
  const authHeader = req.headers.get('authorization');
  if (authHeader) {
    const parts = authHeader.split(' ');
    if (parts.length === 2 && parts[0].toLowerCase() === 'bearer') {
      if (parts[1] === internalToken) return true;
    }
  }

  // Check X-Internal-Token header
  const internalHeader = req.headers.get('x-internal-token');
  if (internalHeader === internalToken) return true;

  return false;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  // AC-CLASSIFY-4.2: 鉴权
  if (!validateToken(req)) {
    return NextResponse.json(
      { error: 'Unauthorized', message: 'Valid INTERNAL_TOKEN required' },
      { status: 401 },
    );
  }

  try {
    // Parse optional concurrency from body
    let concurrency: number | undefined;
    try {
      const body = await req.json();
      if (typeof body?.concurrency === 'number') {
        concurrency = Math.max(1, Math.min(10, body.concurrency));
      }
    } catch {
      // No body or invalid JSON — use default concurrency
    }

    const result = await dispatchTick(concurrency);

    return NextResponse.json({
      ok: true,
      tickId: result.tickId,
      dispatched: result.dispatched,
      succeeded: result.succeeded,
      failed: result.failed,
      durationMs: result.durationMs,
      results: result.results,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal error';
    return NextResponse.json(
      { error: 'DispatchError', message },
      { status: 500 },
    );
  }
}

// Only POST allowed
export async function GET(): Promise<NextResponse> {
  return NextResponse.json(
    { error: 'Method Not Allowed', message: 'Use POST' },
    { status: 405 },
  );
}
