/**
 * DashboardService — FR-W01 仪表盘总览数据层
 *
 * AC1: 核心 KPI 卡片（知识总量、类型分布、状态分布、命中率趋势、未解决冲突、待确认条目）
 * AC2: KPI 趋势同时展示绝对值和百分比变化
 * AC3: 动态推荐下一步操作
 * AC4: basePath 前缀（由调用方注入）
 */

import type { StorageAdapter, QueryResult } from '../storage/storage-types.js';
import type { MetricsCollector } from '../metrics/metrics-collector.js';
import type { TimeWindow } from '../metrics/metrics-types.js';
import type { KnowledgeEntry, KnowledgeType, EntryStatus } from '../types/index.js';
import type {
  KpiCard,
  DashboardOverview,
  DashboardRecommendation,
} from './workbench-types.js';

export interface DashboardServiceDeps {
  storage: StorageAdapter;
  metrics: MetricsCollector;
  basePath?: string;
}

export class DashboardService {
  private storage: StorageAdapter;
  private metrics: MetricsCollector;
  private basePath: string;

  constructor(deps: DashboardServiceDeps) {
    this.storage = deps.storage;
    this.metrics = deps.metrics;
    this.basePath = deps.basePath ?? '';
  }

  async getOverview(currentWindow?: TimeWindow, previousWindow?: TimeWindow): Promise<DashboardOverview> {
    const currentMetrics = this.metrics.aggregate(currentWindow);
    const previousMetrics = previousWindow ? this.metrics.aggregate(previousWindow) : undefined;

    const totalResult = await this.storage.query({}, { offset: 0, limit: 0 });
    const totalEntries = totalResult.total;

    const kpiCards: KpiCard[] = [
      this.buildKpiCard('total-entries', '知识总量', totalEntries, undefined),
      this.buildKpiCard(
        'hit-rate',
        '检索命中率',
        Math.round(currentMetrics.search.hitRate * 100),
        previousMetrics ? Math.round(previousMetrics.search.hitRate * 100) : undefined,
      ),
      this.buildKpiCard(
        'pending-conflicts',
        '未解决冲突',
        currentMetrics.conflict.totalPending,
        previousMetrics?.conflict.totalPending,
      ),
    ];

    const recommendations = this.buildRecommendations(
      currentMetrics.conflict.totalPending,
      0,
      currentMetrics.gapDetection.lastRun?.uncoveredQuestions ?? 0,
      totalEntries,
    );

    return {
      kpiCards,
      metrics: currentMetrics,
      recommendedActions: recommendations,
    };
  }

  private buildKpiCard(key: string, label: string, value: number, previousValue?: number): KpiCard {
    let trend: KpiCard['trend'] = 'flat';
    let changePercent: number | undefined;
    if (previousValue !== undefined && previousValue !== value) {
      trend = value > previousValue ? 'up' : 'down';
      changePercent = previousValue !== 0
        ? Math.round(((value - previousValue) / previousValue) * 100)
        : undefined;
    }
    return { key, label, value, previousValue, changePercent, trend };
  }

  private buildRecommendations(
    pendingConflicts: number,
    _pendingReviews: number,
    knowledgeGaps: number,
    totalEntries: number,
  ): DashboardRecommendation[] {
    const recs: DashboardRecommendation[] = [];
    if (pendingConflicts > 0) {
      recs.push({
        type: 'conflict',
        label: '处理冲突',
        description: `${pendingConflicts} 条知识冲突待裁决`,
        targetPath: `${this.basePath}/conflicts`,
        priority: 1,
      });
    }
    if (knowledgeGaps > 0) {
      recs.push({
        type: 'research',
        label: '启动调研',
        description: `${knowledgeGaps} 个知识缺口待补充`,
        targetPath: `${this.basePath}/research`,
        priority: 2,
      });
    }
    if (totalEntries === 0) {
      recs.push({
        type: 'import',
        label: '导入文档',
        description: '知识库为空，导入文档开始构建',
        targetPath: `${this.basePath}/import`,
        priority: 0,
      });
    }
    return recs.sort((a, b) => a.priority - b.priority);
  }
}
