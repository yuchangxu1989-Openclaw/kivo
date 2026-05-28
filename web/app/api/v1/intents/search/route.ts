import { NextRequest, NextResponse } from 'next/server';
import { badRequest, serverError } from '@/lib/errors';
import { searchIntents } from '@/lib/intent-store';

/**
 * POST /api/v1/intents/search
 * Independent semantic search over the intents table (vector cosine similarity).
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const query = typeof body?.query === 'string' ? body.query.trim() : '';
    const limit = Math.min(50, Math.max(1, Number(body?.limit) || 10));

    if (!query) {
      return badRequest('query is required');
    }

    const results = await searchIntents(query, limit);
    return NextResponse.json({ data: results });
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Unknown error');
  }
}
