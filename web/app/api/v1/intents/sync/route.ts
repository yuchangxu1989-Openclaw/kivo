import { NextResponse } from 'next/server';
import { serverError } from '@/lib/errors';
import type { ApiResponse } from '@/types';

/**
 * POST /api/v1/intents/sync
 * Triggers intent model re-sync after create/edit/delete.
 * In the demo layer this is a no-op that returns success immediately.
 * A real implementation would kick off an async model rebuild.
 */
export async function POST() {
  try {
    return NextResponse.json({
      data: { status: 'syncing', message: '意图模型更新已触发' },
    } satisfies ApiResponse<{ status: string; message: string }>);
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Unknown error');
  }
}
