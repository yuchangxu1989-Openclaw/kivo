/**
 * Metrics Types — 核心指标度量采集
 *
 * FR-X02:
 * - AC1: 检索命中率
 * - AC2: 缺口检测覆盖率
 * - AC3: 规则分发到达率
 * - AC4: 冲突解决率
 * - AC5: 通过仪表盘聚合接口暴露，不引入独立度量存储
 */

export interface SearchMetricRecord {
  timestamp: Date;
  query: string;
  resultCount: number;
  hit: boolean;
}

export interface GapDetectionRecord {
  timestamp: Date;
  totalQuestions: number;
  coveredQuestions: number;
  uncoveredQuestions: number;
}

export interface DistributionRecord {
  timestamp: Date;
  ruleId: string;
  targetCount: number;
  successCount: number;
  failureCount: number;
}

export interface ConflictMetricRecord {
  timestamp: Date;
  produced: number;
  resolved: number;
  pending: number;
}

export interface AggregatedMetrics {
  search: {
    totalQueries: number;
    hitCount: number;
    missCount: number;
    hitRate: number;
  };
  gapDetection: {
    totalRuns: number;
    averageCoverage: number;
    lastRun?: GapDetectionRecord;
  };
  distribution: {
    totalDistributions: number;
    totalTargets: number;
    totalSuccesses: number;
    totalFailures: number;
    deliveryRate: number;
  };
  conflict: {
    totalProduced: number;
    totalResolved: number;
    totalPending: number;
    resolutionRate: number;
  };
  collectedAt: Date;
}

export interface TimeWindow {
  start: Date;
  end: Date;
}
