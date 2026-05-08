/**
 * GET /api/v1/status/is-fresh
 * Returns { isFresh: boolean } — true when the DB contains only seed data.
 */

import { NextResponse } from 'next/server';
import { getKivo } from '@/lib/kivo-engine';
import { serverError } from '@/lib/errors';
import { countEntriesBySource } from '@/lib/paginated-queries';

export async function GET() {
  try {
    await getKivo(); // ensure initialized + seeded

    const { total, seedCount } = countEntriesBySource();
    // Fresh = all entries are seed data (or DB is empty)
    const isFresh = total === 0 || (seedCount > 0 && seedCount === total);

    return NextResponse.json({ data: { isFresh, total, seedCount } });
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Unknown error');
  }
}
