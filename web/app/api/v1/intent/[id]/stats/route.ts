import { NextRequest, NextResponse } from 'next/server';
import { notFound, serverError } from '@/lib/errors';
import { getIntentApiById } from '@/lib/intent-store';
import type { ApiResponse } from '@/types';

export async function GET(
  _request: NextRequest,
  props: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await props.params;
    const item = getIntentApiById(id);
    if (!item) return notFound(`Intent not found: ${id}`);
    const data = {
      hitCount: item.recentHitCount,
      recentHits: item.recentSnippets.map((snippet) => ({ query: snippet.excerpt, timestamp: snippet.hitAt })),
      confidence: item.confidence,
    };
    return NextResponse.json({ data } satisfies ApiResponse<typeof data>);
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Unknown error');
  }
}
