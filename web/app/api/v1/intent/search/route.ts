import { NextRequest, NextResponse } from 'next/server';
import { badRequest, serverError } from '@/lib/errors';
import { searchIntents } from '@/lib/intent-store';
import type { ApiResponse } from '@/types';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as Record<string, unknown>;
    const query = typeof body?.q === 'string' ? body.q.trim() : typeof body?.query === 'string' ? body.query.trim() : '';
    const limit = typeof body?.limit === 'number' ? Math.min(50, Math.max(1, Math.floor(body.limit))) : 10;
    const minScore = typeof body?.minScore === 'number' ? body.minScore : 0.3;

    if (!query) return badRequest('q or query is required');

    const data = await searchIntents(query, limit, minScore);
    return NextResponse.json({ data } satisfies ApiResponse<Awaited<ReturnType<typeof searchIntents>>>);
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Unknown error');
  }
}
