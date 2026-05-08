/**
 * MetricsCollector — 核心指标度量采集器
 *
 * FR-X02:
 * - AC1: 检索命中率 — 记录查询、返回条目数、是否命中，按时间窗口聚合
 * - AC2: 缺口检测覆盖率 — 记录运行结果，支持与基准对比
 * - AC3: 规则分发到达率 — 记录目标数、成功数、失败数
 * - AC4: 冲突解决率 — 记录产生数、已解决数、待裁决数
 * - AC5: 通过仪表盘聚合接口暴露，不引入独立度量存储
 */

import type {
  SearchMetricRecord,
  GapDetectionRecord,
  DistributionRecord,
  ConflictMetricRecord,
  AggregatedMetrics,
  TimeWindow,
} from './metrics-types.js';

export class MetricsCollector {
  private searchRecords: SearchMetricRecord[] = [];
  private gapRecords: GapDetectionRecord[] = [];
  private distributionRecords: DistributionRecord[] = [];
  private conflictRecords: ConflictMetricRecord[] = [];

  // ── AC1: 检索命中率 ──

  recordSearch(query: string, resultCount: number): void {
    this.searchRecords.push({
      timestamp: new Date(),
      query,
      resultCount,
      hit: resultCount > 0,
    });
  }

  // ── AC2: 缺口检测覆盖率 ──

  recordGapDetection(totalQuestions: number, coveredQuestions: number): void {
    this.gapRecords.push({
      timestamp: new Date(),
      totalQuestions,
      coveredQuestions,
      uncoveredQuestions: totalQuestions - coveredQuestions,
    });
  }

  // ── AC3: 规则分发到达率 ──

  recordDistribution(ruleId: string, targetCount: number, successCount: number, failureCount: number): void {
    this.distributionRecords.push({
      timestamp: new Date(),
      ruleId,
      targetCount,
      successCount,
      failureCount,
    });
  }

  // ── AC4: 冲突解决率 ──

  recordConflict(produced: number, resolved: number, pending: number): void {
    this.conflictRecords.push({
      timestamp: new Date(),
      produced,
      resolved,
      pending,
    });
  }

  // ── AC5: 聚合接口 ──

  aggregate(window?: TimeWindow): AggregatedMetrics {
    const searchFiltered = this.filterByWindow(this.searchRecords, window);
    const gapFiltered = this.filterByWindow(this.gapRecords, window);
    const distFiltered = this.filterByWindow(this.distributionRecords, window);
    const conflictFiltered = this.filterByWindow(this.conflictRecords, window);

    // Search metrics
    const totalQueries = searchFiltered.length;
    const hitCount = searchFiltered.filter(r => r.hit).length;
    const missCount = totalQueries - hitCount;

    // Gap detection metrics
    const totalRuns = gapFiltered.length;
    const averageCoverage = totalRuns > 0
      ? gapFiltered.reduce((sum, r) => sum + (r.totalQuestions > 0 ? r.coveredQuestions / r.totalQuestions : 0), 0) / totalRuns
      : 0;

    // Distribution metrics
    const totalDistributions = distFiltered.length;
    const totalTargets = distFiltered.reduce((s, r) => s + r.targetCount, 0);
    const totalSuccesses = distFiltered.reduce((s, r) => s + r.successCount, 0);
    const totalFailures = distFiltered.reduce((s, r) => s + r.failureCount, 0);

    // Conflict metrics
    const totalProduced = conflictFiltered.reduce((s, r) => s + r.produced, 0);
    const totalResolved = conflictFiltered.reduce((s, r) => s + r.resolved, 0);
    const totalPending = conflictFiltered.reduce((s, r) => s + r.pending, 0);

    return {
      search: {
        totalQueries,
        hitCount,
        missCount,
        hitRate: totalQueries > 0 ? hitCount / totalQueries : 0,
      },
      gapDetection: {
        totalRuns,
        averageCoverage,
        lastRun: gapFiltered.length > 0 ? gapFiltered[gapFiltered.length - 1] : undefined,
      },
      distribution: {
        totalDistributions,
        totalTargets,
        totalSuccesses,
        totalFailures,
        deliveryRate: totalTargets > 0 ? totalSuccesses / totalTargets : 0,
      },
      conflict: {
        totalProduced,
        totalResolved,
        totalPending,
        resolutionRate: totalProduced > 0 ? totalResolved / totalProduced : 0,
      },
      collectedAt: new Date(),
    };
  }

  /** 获取原始记录（用于调试） */
  getRawRecords() {
    return {
      search: [...this.searchRecords],
      gapDetection: [...this.gapRecords],
      distribution: [...this.distributionRecords],
      conflict: [...this.conflictRecords],
    };
  }

  /** 清除所有记录 */
  clear(): void {
    this.searchRecords = [];
    this.gapRecords = [];
    this.distributionRecords = [];
    this.conflictRecords = [];
  }

  private filterByWindow<T extends { timestamp: Date }>(records: T[], window?: TimeWindow): T[] {
    if (!window) return records;
    return records.filter(r => r.timestamp >= window.start && r.timestamp <= window.end);
  }
}
