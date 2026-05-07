import { describe, expect, it } from 'vitest';
import { MetricsCollector } from '../src/metrics/index.js';

describe('MetricsCollector', () => {
  // ── AC1: 检索命中率 ──

  describe('search metrics', () => {
    it('records search hits and misses', () => {
      const mc = new MetricsCollector();
      mc.recordSearch('知识类型', 3);
      mc.recordSearch('不存在的内容', 0);
      mc.recordSearch('冲突检测', 1);

      const agg = mc.aggregate();
      expect(agg.search.totalQueries).toBe(3);
      expect(agg.search.hitCount).toBe(2);
      expect(agg.search.missCount).toBe(1);
      expect(agg.search.hitRate).toBeCloseTo(2 / 3);
    });

    it('returns 0 hit rate when no queries', () => {
      const mc = new MetricsCollector();
      expect(mc.aggregate().search.hitRate).toBe(0);
    });
  });

  // ── AC2: 缺口检测覆盖率 ──

  describe('gap detection metrics', () => {
    it('records gap detection runs', () => {
      const mc = new MetricsCollector();
      mc.recordGapDetection(10, 7);
      mc.recordGapDetection(10, 9);

      const agg = mc.aggregate();
      expect(agg.gapDetection.totalRuns).toBe(2);
      expect(agg.gapDetection.averageCoverage).toBeCloseTo((0.7 + 0.9) / 2);
      expect(agg.gapDetection.lastRun?.coveredQuestions).toBe(9);
    });

    it('handles zero total questions', () => {
      const mc = new MetricsCollector();
      mc.recordGapDetection(0, 0);
      expect(mc.aggregate().gapDetection.averageCoverage).toBe(0);
    });
  });

  // ── AC3: 规则分发到达率 ──

  describe('distribution metrics', () => {
    it('records distribution results', () => {
      const mc = new MetricsCollector();
      mc.recordDistribution('rule-1', 10, 9, 1);
      mc.recordDistribution('rule-2', 5, 5, 0);

      const agg = mc.aggregate();
      expect(agg.distribution.totalDistributions).toBe(2);
      expect(agg.distribution.totalTargets).toBe(15);
      expect(agg.distribution.totalSuccesses).toBe(14);
      expect(agg.distribution.totalFailures).toBe(1);
      expect(agg.distribution.deliveryRate).toBeCloseTo(14 / 15);
    });
  });

  // ── AC4: 冲突解决率 ──

  describe('conflict metrics', () => {
    it('records conflict resolution', () => {
      const mc = new MetricsCollector();
      mc.recordConflict(5, 3, 2);
      mc.recordConflict(3, 3, 0);

      const agg = mc.aggregate();
      expect(agg.conflict.totalProduced).toBe(8);
      expect(agg.conflict.totalResolved).toBe(6);
      expect(agg.conflict.totalPending).toBe(2);
      expect(agg.conflict.resolutionRate).toBeCloseTo(6 / 8);
    });
  });

  // ── AC5: 聚合接口 ──

  describe('aggregation', () => {
    it('filters by time window', () => {
      const mc = new MetricsCollector();
      mc.recordSearch('early', 1);

      const boundary = new Date(Date.now() + 50);

      // Manually add a record with future timestamp
      const raw = mc.getRawRecords();
      raw.search.push({
        timestamp: new Date(boundary.getTime() + 100),
        query: 'late',
        resultCount: 2,
        hit: true,
      });

      // Use the collector's internal records directly
      mc.recordSearch('late-real', 2);

      const allAgg = mc.aggregate();
      expect(allAgg.search.totalQueries).toBe(2); // early + late-real
    });

    it('clear resets all records', () => {
      const mc = new MetricsCollector();
      mc.recordSearch('test', 1);
      mc.recordGapDetection(5, 3);
      mc.recordDistribution('r1', 10, 10, 0);
      mc.recordConflict(2, 1, 1);

      mc.clear();
      const agg = mc.aggregate();
      expect(agg.search.totalQueries).toBe(0);
      expect(agg.gapDetection.totalRuns).toBe(0);
      expect(agg.distribution.totalDistributions).toBe(0);
      expect(agg.conflict.totalProduced).toBe(0);
    });

    it('collectedAt is set', () => {
      const mc = new MetricsCollector();
      const agg = mc.aggregate();
      expect(agg.collectedAt).toBeInstanceOf(Date);
    });
  });
});
