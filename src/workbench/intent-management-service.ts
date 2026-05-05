/**
 * IntentManagementService — FR-W10 意图库管理数据层
 *
 * AC1: 意图列表（名称、描述、正例数、负例数、关联知识条目数）
 * AC2: 批量粘贴 + 逐条添加正例/负例
 * AC3: 删除确认（展示关联知识条目数量）
 * AC4: 保存后触发意图理解模型增量更新
 * AC5: 最近 30 天匹配命中次数 + 典型命中对话片段
 */

import type {
  IntentListItem,
  IntentDetail,
  IntentMatchStats,
  UpsertIntentRequest,
} from './workbench-types.js';

export interface IntentRecord {
  id: string;
  name: string;
  description: string;
  positives: string[];
  negatives: string[];
  linkedEntryIds: string[];
}

export interface IntentStore {
  list(): Promise<IntentRecord[]>;
  get(id: string): Promise<IntentRecord | null>;
  upsert(record: IntentRecord): Promise<IntentRecord>;
  delete(id: string): Promise<boolean>;
}

export interface IntentModelUpdater {
  triggerIncrementalUpdate(intentId: string): Promise<'updating' | 'completed' | 'failed'>;
  getUpdateStatus(intentId: string): Promise<'idle' | 'updating' | 'completed' | 'failed'>;
}

export interface IntentMatchStatsProvider {
  getStats(intentId: string, days: number): Promise<IntentMatchStats>;
}

export interface IntentManagementServiceDeps {
  store: IntentStore;
  modelUpdater?: IntentModelUpdater;
  matchStats?: IntentMatchStatsProvider;
}

export class IntentManagementService {
  private store: IntentStore;
  private modelUpdater?: IntentModelUpdater;
  private matchStats?: IntentMatchStatsProvider;

  constructor(deps: IntentManagementServiceDeps) {
    this.store = deps.store;
    this.modelUpdater = deps.modelUpdater;
    this.matchStats = deps.matchStats;
  }

  /** AC1: 意图列表 */
  async list(): Promise<IntentListItem[]> {
    const records = await this.store.list();
    return records.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      positiveCount: r.positives.length,
      negativeCount: r.negatives.length,
      linkedEntryCount: r.linkedEntryIds.length,
    }));
  }

  /** AC5: 意图详情（含匹配统计） */
  async getDetail(intentId: string): Promise<IntentDetail | null> {
    const record = await this.store.get(intentId);
    if (!record) return null;

    const matchStatsData = this.matchStats
      ? await this.matchStats.getStats(intentId, 30)
      : undefined;

    const modelStatus = this.modelUpdater
      ? await this.modelUpdater.getUpdateStatus(intentId)
      : undefined;

    return {
      id: record.id,
      name: record.name,
      description: record.description,
      positives: record.positives,
      negatives: record.negatives,
      linkedEntryIds: record.linkedEntryIds,
      matchStats: matchStatsData,
      modelUpdateStatus: modelStatus,
    };
  }

  /** AC2 + AC4: 新增/编辑意图 */
  async upsert(id: string, request: UpsertIntentRequest): Promise<IntentDetail> {
    const existing = await this.store.get(id);
    const record: IntentRecord = {
      id,
      name: request.name,
      description: request.description,
      positives: request.positives,
      negatives: request.negatives,
      linkedEntryIds: existing?.linkedEntryIds ?? [],
    };
    const saved = await this.store.upsert(record);

    // AC4: 触发模型增量更新
    let modelUpdateStatus: IntentDetail['modelUpdateStatus'];
    if (this.modelUpdater) {
      modelUpdateStatus = await this.modelUpdater.triggerIncrementalUpdate(id);
    }

    return {
      id: saved.id,
      name: saved.name,
      description: saved.description,
      positives: saved.positives,
      negatives: saved.negatives,
      linkedEntryIds: saved.linkedEntryIds,
      modelUpdateStatus,
    };
  }

  /** AC3: 删除意图（返回关联数量供确认） */
  async getDeleteConfirmation(intentId: string): Promise<{ linkedEntryCount: number } | null> {
    const record = await this.store.get(intentId);
    if (!record) return null;
    return { linkedEntryCount: record.linkedEntryIds.length };
  }

  async deleteIntent(intentId: string): Promise<boolean> {
    return this.store.delete(intentId);
  }
}
