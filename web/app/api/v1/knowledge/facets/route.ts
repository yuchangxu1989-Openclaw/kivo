/**
 * GET /api/v1/knowledge/facets
 * Distinct values for the three-dimensional filters (nature / function / domain),
 * computed from active knowledge entries (FR-B05 / AC-B05-6). The UI consumes
 * this so filter options stay data-driven and never hardcode subject names.
 */

import { NextResponse } from 'next/server';
import { getKivo } from '@/lib/kivo-engine';
import { serverError } from '@/lib/errors';
import { getKnowledgeFacets } from '@/lib/paginated-queries';
import type { ApiResponse } from '@/types';

export async function GET() {
  try {
    await getKivo(); // ensure DB initialized
    const facets = getKnowledgeFacets();
    const response: ApiResponse<typeof facets> = { data: facets };
    return NextResponse.json(response);
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Unknown error');
  }
}
