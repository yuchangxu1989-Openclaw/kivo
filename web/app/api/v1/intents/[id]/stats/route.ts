import { NextRequest, NextResponse } from 'next/server';
import { notFound, serverError } from '@/lib/errors';
import { getIntentById } from '@/lib/domain-stores';
import type { ApiResponse } from '@/types';

interface IntentStatsResponse {
  hitCount: number;
  recentHits: { query: string; timestamp: string }[];
}

export async function GET(
  _request: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    const { id } = params;
    const item = getIntentById(id);
    if (!item) {
      return notFound(`Intent not found: ${id}`);
    }

    const response: ApiResponse<IntentStatsResponse> = {
      data: {
        hitCount: item.recentHitCount,
        recentHits: item.recentSnippets.map((s) => ({
          query: s.excerpt,
          timestamp: s.hitAt,
        })),
      },
    };
    return NextResponse.json(response);
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Unknown error');
  }
}
