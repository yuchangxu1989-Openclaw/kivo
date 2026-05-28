export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/stats
 * Aggregated statistics for the branded dashboard homepage.
 * Uses SQL COUNT queries and precomputed graph tables — no full table scans.
 */

import { NextResponse } from 'next/server';
import { getKivo } from '@/lib/kivo-engine';
import { serverError } from '@/lib/errors';
import { getDictionaryData, getActivityFeedData } from '@/lib/domain-stores';
import { getEntryCounts } from '@/lib/paginated-queries';
import { getGraphCounts, graphTablesExist } from '@/lib/graph-db';
import type { ApiResponse } from '@/types';

export interface StatsResponse {
  totalEntries: number;
  byType: Record<string, number>;
  byStatus: Record<string, number>;
  graph: { nodes: number; edges: number };
  dictionaryTerms: number;
  lastUpdated: string | null;
  recentActivity: Array<{
    id: string;
    title: string;
    type: string;
    timestamp: string;
  }>;
}

export async function GET() {
  try {
    await getKivo(); // ensure initialized + seeded

    // SQL-level aggregation — no findAll()
    const counts = getEntryCounts();

    // Graph stats from precomputed tables — no O(N²) build
    let graphNodes = 0;
    let graphEdges = 0;
    try {
      if (graphTablesExist()) {
        const gc = getGraphCounts();
        graphNodes = gc.nodes;
        graphEdges = gc.edges;
      }
    } catch {
      // graph tables may not exist yet
    }

    // Dictionary stats
    let dictionaryTerms = 0;
    try {
      const dictData = getDictionaryData();
      dictionaryTerms = dictData.entries?.length ?? 0;
    } catch {
      // dictionary may not be seeded
    }

    // Recent activity (last 10)
    const recentActivity: StatsResponse['recentActivity'] = [];
    try {
      const feed = getActivityFeedData();
      const items = (feed.items ?? []).slice(0, 10);
      for (const item of items) {
        const rec = item as unknown as Record<string, string>;
        recentActivity.push({
          id: rec.id ?? item.id,
          title: rec.title ?? rec.label ?? rec.summary ?? '',
          type: rec.type ?? item.type,
          timestamp: rec.timestamp ?? rec.occurredAt ?? rec.time ?? '',
        });
      }
    } catch {
      // activity may not be seeded yet
    }

    const stats: StatsResponse = {
      totalEntries: counts.total,
      byType: counts.byType,
      byStatus: counts.byStatus,
      graph: { nodes: graphNodes, edges: graphEdges },
      dictionaryTerms,
      lastUpdated: counts.lastUpdated,
      recentActivity,
    };

    const response: ApiResponse<StatsResponse> = { data: stats };
    return NextResponse.json(response);
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Unknown error');
  }
}
