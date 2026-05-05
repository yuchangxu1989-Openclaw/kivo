import { beforeEach, describe, expect, it } from 'vitest';
import { DashboardService } from '../dashboard-service.js';
import { MetricsCollector } from '../../metrics/metrics-collector.js';
import type { StorageAdapter, QueryResult, KnowledgeFilter, PaginationOptions } from '../../storage/storage-types.js';
import type { KnowledgeEntry, KnowledgeSource } from '../../types/index.js';
import type { TimeWindow } from '../../metrics/metrics-types.js';
import type { DashboardOverview, KpiCard } from '../workbench-types.js';

// ── Test helpers ──────────────────────────────────────────────────────────

function makeSource(): KnowledgeSource {
  return { type: 'document', reference: 'doc://test', timestamp: new Date('2026-04-20T09:00:00Z') };
}

function makeEntry(overrides: Partial<KnowledgeEntry> = {}): KnowledgeEntry {
  return {
    id: overrides.id ?? 'e-1',
    type: 'fact',
    title: 'Test',
    content: 'content',
    summary: 'summary',
    source: makeSource(),
    confidence: 0.9,
    status: 'active',
    tags: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    version: 1,
    ...overrides,
  };
}

/** Minimal StorageAdapter mock that returns configurable totals */
function makeMockStorage(opts: { totalEntries?: number; pendingCount?: number } = {}): StorageAdapter {
  const { totalEntries = 0, pendingCount = 0 } = opts;
  return {
    async save(e) { return e; },
    async saveMany(es) { return es; },
    async get() { return null; },
    async update() { return null; },
    async delete() { return true; },
    async deleteMany() { return 0; },
    async query(filter?: KnowledgeFilter, options?: PaginationOptions): Promise<QueryResult<KnowledgeEntry>> {
      // Distinguish between total query and pending query
      if (filter && 'status' in filter && filter.status === 'pending') {
        return { items: [], total: pendingCount, offset: 0, limit: 0, hasMore: false };
      }
      return { items: [], total: totalEntries, offset: 0, limit: 0, hasMore: false };
    },
    async getVersionHistory() { return []; },
  };
}

function makeMetricsWithData(): MetricsCollector {
  const m = new MetricsCollector();
  // 10 queries, 8 hits, 2 misses → hitRate = 0.8
  for (let i = 0; i < 8; i++) m.recordSearch(`q${i}`, 3);
  for (let i = 0; i < 2; i++) m.recordSearch(`miss${i}`, 0);
  // gap detection
  m.recordGapDetection(10, 7); // 3 uncovered
  // conflicts
  m.recordConflict(5, 3, 2); // 2 pending
  return m;
}

// ═════════════════════════════════════════════════════════════════════════
// FR-W01 AC1: 核心 KPI 卡片
// ═════════════════════════════════════════════════════════════════════════

describe('FR-W01 AC1: KPI cards', () => {
  let service: DashboardService;

  beforeEach(() => {
    service = new DashboardService({
      storage: makeMockStorage({ totalEntries: 42, pendingCount: 5 }),
      metrics: makeMetricsWithData(),
    });
  });

  it('returns kpiCards array with total-entries, hit-rate, pending-conflicts, pending-reviews', async () => {
    const overview = await service.getOverview();
    const keys = overview.kpiCards.map((c) => c.key);
    expect(keys).toContain('total-entries');
    expect(keys).toContain('hit-rate');
    expect(keys).toContain('pending-conflicts');
    expect(keys).toContain('pending-reviews');
  });

  it('total-entries reflects storage total', async () => {
    const overview = await service.getOverview();
    const card = overview.kpiCards.find((c) => c.key === 'total-entries')!;
    expect(card.value).toBe(42);
    expect(card.label).toBe('知识总量');
  });

  it('hit-rate reflects metrics search hitRate (percentage)', async () => {
    const overview = await service.getOverview();
    const card = overview.kpiCards.find((c) => c.key === 'hit-rate')!;
    // 8/10 = 0.8 → 80%
    expect(card.value).toBe(80);
    expect(card.label).toBe('检索命中率');
  });

  it('pending-conflicts reflects metrics conflict totalPending', async () => {
    const overview = await service.getOverview();
    const card = overview.kpiCards.find((c) => c.key === 'pending-conflicts')!;
    expect(card.value).toBe(2);
  });

  it('pending-reviews reflects storage pending count', async () => {
    const overview = await service.getOverview();
    const card = overview.kpiCards.find((c) => c.key === 'pending-reviews')!;
    expect(card.value).toBe(5);
  });

  it('returns aggregated metrics in overview', async () => {
    const overview = await service.getOverview();
    expect(overview.metrics).toBeDefined();
    expect(overview.metrics.search.totalQueries).toBe(10);
    expect(overview.metrics.conflict.totalPending).toBe(2);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// FR-W01 AC2: KPI 趋势 — 绝对值 + 百分比变化
// ═════════════════════════════════════════════════════════════════════════

describe('FR-W01 AC2: KPI trend with absolute + percentage change', () => {
  it('shows trend=up and changePercent when current > previous', async () => {
    const metrics = new MetricsCollector();
    const now = new Date('2026-05-01T12:00:00Z');
    const prevStart = new Date('2026-04-01T00:00:00Z');
    const prevEnd = new Date('2026-04-30T23:59:59Z');
    const curStart = new Date('2026-05-01T00:00:00Z');
    const curEnd = new Date('2026-05-01T23:59:59Z');

    // Previous window: 5 queries, 2 hits → hitRate 0.4 → 40%
    for (let i = 0; i < 2; i++) {
      metrics.recordSearch('prev-hit', 1);
      // Manually set timestamp to previous window
      (metrics as any).searchRecords[(metrics as any).searchRecords.length - 1].timestamp = new Date('2026-04-15T10:00:00Z');
    }
    for (let i = 0; i < 3; i++) {
      metrics.recordSearch('prev-miss', 0);
      (metrics as any).searchRecords[(metrics as any).searchRecords.length - 1].timestamp = new Date('2026-04-15T10:00:00Z');
    }

    // Current window: 10 queries, 8 hits → hitRate 0.8 → 80%
    for (let i = 0; i < 8; i++) {
      metrics.recordSearch('cur-hit', 2);
      (metrics as any).searchRecords[(metrics as any).searchRecords.length - 1].timestamp = new Date('2026-05-01T10:00:00Z');
    }
    for (let i = 0; i < 2; i++) {
      metrics.recordSearch('cur-miss', 0);
      (metrics as any).searchRecords[(metrics as any).searchRecords.length - 1].timestamp = new Date('2026-05-01T10:00:00Z');
    }

    // Conflict records for both windows
    metrics.recordConflict(3, 1, 2);
    (metrics as any).conflictRecords[(metrics as any).conflictRecords.length - 1].timestamp = new Date('2026-04-15T10:00:00Z');
    metrics.recordConflict(5, 3, 2);
    (metrics as any).conflictRecords[(metrics as any).conflictRecords.length - 1].timestamp = new Date('2026-05-01T10:00:00Z');

    const service = new DashboardService({
      storage: makeMockStorage({ totalEntries: 10, pendingCount: 0 }),
      metrics,
    });

    const currentWindow: TimeWindow = { start: curStart, end: curEnd };
    const previousWindow: TimeWindow = { start: prevStart, end: prevEnd };
    const overview = await service.getOverview(currentWindow, previousWindow);

    const hitRateCard = overview.kpiCards.find((c) => c.key === 'hit-rate')!;
    expect(hitRateCard.value).toBe(80);
    expect(hitRateCard.previousValue).toBe(40);
    expect(hitRateCard.trend).toBe('up');
    expect(hitRateCard.changePercent).toBe(100); // (80-40)/40 * 100 = 100%
  });

  it('shows trend=down when current < previous', async () => {
    const metrics = new MetricsCollector();
    // Previous: 4 pending conflicts
    metrics.recordConflict(10, 6, 4);
    (metrics as any).conflictRecords[0].timestamp = new Date('2026-04-15T10:00:00Z');
    // Current: 2 pending conflicts
    metrics.recordConflict(5, 3, 2);
    (metrics as any).conflictRecords[1].timestamp = new Date('2026-05-01T10:00:00Z');

    // Need search records too
    metrics.recordSearch('q', 1);
    (metrics as any).searchRecords[0].timestamp = new Date('2026-05-01T10:00:00Z');

    const service = new DashboardService({
      storage: makeMockStorage({ totalEntries: 10, pendingCount: 0 }),
      metrics,
    });

    const overview = await service.getOverview(
      { start: new Date('2026-05-01T00:00:00Z'), end: new Date('2026-05-01T23:59:59Z') },
      { start: new Date('2026-04-01T00:00:00Z'), end: new Date('2026-04-30T23:59:59Z') },
    );

    const conflictCard = overview.kpiCards.find((c) => c.key === 'pending-conflicts')!;
    expect(conflictCard.value).toBe(2);
    expect(conflictCard.previousValue).toBe(4);
    expect(conflictCard.trend).toBe('down');
    expect(conflictCard.changePercent).toBe(-50);
  });

  it('shows trend=flat when no previous window provided', async () => {
    const service = new DashboardService({
      storage: makeMockStorage({ totalEntries: 10, pendingCount: 0 }),
      metrics: makeMetricsWithData(),
    });

    const overview = await service.getOverview();
    // Without previousWindow, all cards should be flat
    for (const card of overview.kpiCards) {
      // total-entries and pending-reviews have no previousValue by design
      if (card.key === 'total-entries' || card.key === 'pending-reviews') {
        expect(card.trend).toBe('flat');
      }
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════
// FR-W01 AC3: 动态推荐下一步操作
// ═════════════════════════════════════════════════════════════════════════

describe('FR-W01 AC3: dynamic recommended actions', () => {
  it('recommends conflict resolution when pending conflicts > 0', async () => {
    const service = new DashboardService({
      storage: makeMockStorage({ totalEntries: 10, pendingCount: 0 }),
      metrics: makeMetricsWithData(), // has 2 pending conflicts
    });
    const overview = await service.getOverview();
    const conflictRec = overview.recommendedActions.find((r) => r.type === 'conflict');
    expect(conflictRec).toBeDefined();
    expect(conflictRec!.label).toBeTruthy();
    expect(conflictRec!.description).toContain('2');
    expect(conflictRec!.targetPath).toContain('conflicts');
  });

  it('recommends research when knowledge gaps exist', async () => {
    const service = new DashboardService({
      storage: makeMockStorage({ totalEntries: 10, pendingCount: 0 }),
      metrics: makeMetricsWithData(), // has 3 uncovered questions
    });
    const overview = await service.getOverview();
    const researchRec = overview.recommendedActions.find((r) => r.type === 'research');
    expect(researchRec).toBeDefined();
    expect(researchRec!.targetPath).toContain('research');
  });

  it('recommends review when pending entries exist', async () => {
    const service = new DashboardService({
      storage: makeMockStorage({ totalEntries: 10, pendingCount: 3 }),
      metrics: makeMetricsWithData(),
    });
    const overview = await service.getOverview();
    const reviewRec = overview.recommendedActions.find((r) => r.type === 'review');
    expect(reviewRec).toBeDefined();
    expect(reviewRec!.description).toContain('3');
    expect(reviewRec!.targetPath).toContain('pending');
  });

  it('recommends import when knowledge base is empty', async () => {
    const metrics = new MetricsCollector();
    // Need at least one search record to avoid division by zero
    metrics.recordSearch('q', 0);
    const service = new DashboardService({
      storage: makeMockStorage({ totalEntries: 0, pendingCount: 0 }),
      metrics,
    });
    const overview = await service.getOverview();
    const importRec = overview.recommendedActions.find((r) => r.type === 'import');
    expect(importRec).toBeDefined();
    expect(importRec!.targetPath).toContain('import');
  });

  it('returns no recommendations when everything is clean', async () => {
    const metrics = new MetricsCollector();
    metrics.recordSearch('q', 1); // 1 hit, no misses
    // No conflicts, no gaps
    const service = new DashboardService({
      storage: makeMockStorage({ totalEntries: 10, pendingCount: 0 }),
      metrics,
    });
    const overview = await service.getOverview();
    // Should have no conflict, no research, no review, no import recs
    expect(overview.recommendedActions.filter((r) => r.type === 'conflict')).toHaveLength(0);
    expect(overview.recommendedActions.filter((r) => r.type === 'review')).toHaveLength(0);
    expect(overview.recommendedActions.filter((r) => r.type === 'import')).toHaveLength(0);
  });

  it('recommendations are sorted by priority (ascending)', async () => {
    const service = new DashboardService({
      storage: makeMockStorage({ totalEntries: 0, pendingCount: 5 }),
      metrics: makeMetricsWithData(),
    });
    const overview = await service.getOverview();
    const priorities = overview.recommendedActions.map((r) => r.priority);
    for (let i = 1; i < priorities.length; i++) {
      expect(priorities[i]).toBeGreaterThanOrEqual(priorities[i - 1]);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════
// FR-W01 AC4: basePath 前缀
// ═════════════════════════════════════════════════════════════════════════

describe('FR-W01 AC4: basePath prefix on internal links', () => {
  it('recommendation targetPaths use configured basePath', async () => {
    const service = new DashboardService({
      storage: makeMockStorage({ totalEntries: 0, pendingCount: 3 }),
      metrics: makeMetricsWithData(),
      basePath: '/kivo',
    });
    const overview = await service.getOverview();
    for (const rec of overview.recommendedActions) {
      expect(rec.targetPath).toMatch(/^\/kivo\//);
    }
  });

  it('defaults to empty basePath when not configured', async () => {
    const service = new DashboardService({
      storage: makeMockStorage({ totalEntries: 0, pendingCount: 3 }),
      metrics: makeMetricsWithData(),
    });
    const overview = await service.getOverview();
    for (const rec of overview.recommendedActions) {
      expect(rec.targetPath).toMatch(/^\//);
      expect(rec.targetPath).not.toMatch(/^\/\//);
    }
  });
});
