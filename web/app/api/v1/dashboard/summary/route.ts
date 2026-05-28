/**
 * GET /api/v1/dashboard/summary
 * Knowledge base overview statistics (FR-W01)
 */

import { NextResponse } from 'next/server';
import { getKivo } from '@/lib/kivo-engine';
import { serverError } from '@/lib/errors';
import {
  getEntryCounts,
  countEntriesInWindow,
  getActiveTypeCounts,
  getDailyEntryCounts,
} from '@/lib/paginated-queries';
import { getGraphCounts, graphTablesExist } from '@/lib/graph-db';
import { getWikiRepository } from '@/lib/wiki-engine';
import type { ApiResponse, DashboardMetricTrend, DashboardSummary, WikiSpaceSummary } from '@/types';

const DAY_MS = 24 * 60 * 60 * 1000;
const TREND_WINDOW_DAYS = 7;

function buildTrend(current: number, previous: number): DashboardMetricTrend {
  if (current === previous) {
    return { percent: 0, direction: 'flat', current, previous };
  }
  if (previous === 0) {
    return {
      percent: current === 0 ? 0 : 100,
      direction: current > 0 ? 'up' : 'flat',
      current,
      previous,
    };
  }
  const delta = ((current - previous) / previous) * 100;
  return {
    percent: Math.round(Math.abs(delta)),
    direction: delta > 0 ? 'up' : 'down',
    current,
    previous,
  };
}

export async function GET() {
  try {
    await getKivo();

    const counts = getEntryCounts();
    const { total: totalEntries, byType, byStatus } = counts;
    const activeByType = getActiveTypeCounts();
    const growthLast7Days = getDailyEntryCounts(7);

    let graph = { nodes: 0, edges: 0 };
    try {
      if (graphTablesExist()) {
        graph = getGraphCounts();
      }
    } catch {
      graph = { nodes: 0, edges: 0 };
    }

    // Wiki spaces summary for dashboard cards
    let wikiSpaces: WikiSpaceSummary[] = [];
    try {
      const repo = getWikiRepository();
      const spaces = repo.listSpaces();
      wikiSpaces = spaces.map((s) => ({
        id: s.id,
        title: s.title,
        icon: s.metadata.extra?.icon as string | undefined,
        entryCount: repo.getSpaceTree(s.id).children.reduce((count, child) => {
          const visit = (node: typeof child): number => node.type === 'wiki_page' ? 1 : node.children.reduce((sum, nested) => sum + visit(nested), 0);
          return count + visit(child);
        }, 0),
        updatedAt: s.updatedAt,
      }));
    } catch {
      wikiSpaces = [];
    }

    const now = Date.now();
    const currentWindowStart = new Date(now - TREND_WINDOW_DAYS * DAY_MS).toISOString();
    const previousWindowStart = new Date(now - TREND_WINDOW_DAYS * 2 * DAY_MS).toISOString();

    const currentWindowCount = countEntriesInWindow(currentWindowStart);
    const previousWindowCount = countEntriesInWindow(previousWindowStart, currentWindowStart);

    const summary: DashboardSummary = {
      totalEntries,
      weeklyNewEntries: currentWindowCount,
      wikiSpaceCount: wikiSpaces.length,
      wikiSpaces,
      byType,
      byStatus,
      activeByType,
      graph,
      growth: {
        last7Days: growthLast7Days,
      },
      trends: {
        totalEntries: buildTrend(totalEntries, totalEntries - currentWindowCount),
        weeklyNewEntries: buildTrend(currentWindowCount, previousWindowCount),
      },
    };

    const response: ApiResponse<DashboardSummary> = { data: summary };
    return NextResponse.json(response);
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Unknown error');
  }
}
