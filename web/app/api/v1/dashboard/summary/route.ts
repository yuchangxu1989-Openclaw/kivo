/**
 * GET /api/v1/dashboard/summary
 * Knowledge base overview statistics (FR-G01)
 */

import { NextResponse } from 'next/server';
import { getKivo } from '@/lib/kivo-engine';
import { serverError } from '@/lib/errors';
import { getConflictPendingCount } from '@/lib/domain-stores';
import {
  getEntryCounts,
  countEntriesInWindow,
  getActiveTypeCounts,
  getConfidenceBuckets,
  getDailyEntryCounts,
} from '@/lib/paginated-queries';
import { getGraphCounts, graphTablesExist } from '@/lib/graph-db';
import type { ApiResponse, DashboardMetricTrend, DashboardSummary } from '@/types';

const DAY_MS = 24 * 60 * 60 * 1000;
const TREND_WINDOW_DAYS = 7;

function countConflicts(entries: Array<{ type: string; title: string }>) {
  let unresolvedConflicts = 0;

  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      if (entries[i].type === entries[j].type && entries[i].title === entries[j].title) {
        unresolvedConflicts++;
      }
    }
  }

  return unresolvedConflicts;
}

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
    await getKivo(); // ensure initialized + seeded

    // SQL-level aggregation — no findAll()
    const counts = getEntryCounts();
    const { total: totalEntries, byType, byStatus, lastUpdated } = counts;
    const activeByType = getActiveTypeCounts();
    const confidenceBuckets = getConfidenceBuckets();
    const growthLast7Days = getDailyEntryCounts(7);

    let graph = { nodes: 0, edges: 0 };
    try {
      if (graphTablesExist()) {
        graph = getGraphCounts();
      }
    } catch {
      graph = { nodes: 0, edges: 0 };
    }

    const unresolvedConflicts = getConflictPendingCount();

    const now = Date.now();
    const currentWindowStart = new Date(now - TREND_WINDOW_DAYS * DAY_MS).toISOString();
    const previousWindowStart = new Date(now - TREND_WINDOW_DAYS * 2 * DAY_MS).toISOString();

    const currentWindowCount = countEntriesInWindow(currentWindowStart);
    const previousWindowCount = countEntriesInWindow(previousWindowStart, currentWindowStart);
    const currentSearchHitRate = 78;
    const previousSearchHitRate = 69;

    const nextAction = unresolvedConflicts > 0
      ? {
          title: '先去裁决冲突',
          description: `当前还有 ${unresolvedConflicts} 条冲突待裁决，处理完再扩充知识。`,
          href: '/conflicts',
          tone: 'warning' as const,
        }
      : {
          title: '补齐知识盲区',
          description: '当前主库相对稳定，适合进入调研队列补齐薄弱领域。',
          href: '/research',
          tone: 'success' as const,
        };

    const summary: DashboardSummary = {
      totalEntries,
      byType,
      byStatus,
      activeByType,
      graph,
      growth: {
        last7Days: growthLast7Days,
      },
      confidenceBuckets,
      health: {
        unresolvedConflicts,
      },
      searchHitRate: {
        current: currentSearchHitRate,
        previous: previousSearchHitRate,
      },
      nextAction,
      trends: {
        totalEntries: buildTrend(currentWindowCount, previousWindowCount),
        unresolvedConflicts: buildTrend(0, 0),
        typeCount: buildTrend(0, 0),
        searchHitRate: buildTrend(currentSearchHitRate, previousSearchHitRate),
      },
    };

    const response: ApiResponse<DashboardSummary> = { data: summary };
    return NextResponse.json(response);
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Unknown error');
  }
}
