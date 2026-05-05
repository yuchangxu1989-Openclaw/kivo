/**
 * ConflictAdjudicationService — FR-W05 冲突裁决数据层
 *
 * AC1: 待裁决冲突列表（冲突双方摘要、类型、检测时间）
 * AC2: 裁决操作（保留一方、合并、同时废弃）
 * AC3: 裁决结果记录（操作人、时间、理由）
 */

import type { StorageAdapter } from '../storage/storage-types.js';
import type { ConflictRecord } from '../conflict/conflict-record.js';
import type {
  ConflictSummary,
  AdjudicationRequest,
  AdjudicationResult,
} from './workbench-types.js';

export interface ConflictStore {
  getPendingConflicts(): Promise<ConflictRecord[]>;
  getConflict(id: string): Promise<ConflictRecord | null>;
  resolveConflict(id: string, winnerId: string | null, resolution: string): Promise<ConflictRecord>;
}

export interface ConflictAdjudicationServiceDeps {
  storage: StorageAdapter;
  conflictStore: ConflictStore;
}

export class ConflictAdjudicationService {
  private storage: StorageAdapter;
  private conflictStore: ConflictStore;

  constructor(deps: ConflictAdjudicationServiceDeps) {
    this.storage = deps.storage;
    this.conflictStore = deps.conflictStore;
  }

  /** AC1: 获取所有待裁决冲突 */
  async listPending(): Promise<ConflictSummary[]> {
    const records = await this.conflictStore.getPendingConflicts();
    const summaries: ConflictSummary[] = [];

    for (const record of records) {
      const incoming = await this.storage.get(record.incomingId);
      const existing = await this.storage.get(record.existingId);
      summaries.push({
        record,
        incomingSummary: incoming?.summary ?? '(已删除)',
        existingSummary: existing?.summary ?? '(已删除)',
        conflictType: record.verdict,
      });
    }

    return summaries;
  }

  /** AC2 + AC3: 执行裁决 */
  async adjudicate(request: AdjudicationRequest): Promise<AdjudicationResult> {
    const record = await this.conflictStore.getConflict(request.conflictId);
    if (!record) {
      throw new Error(`Conflict ${request.conflictId} not found`);
    }

    let winnerId: string | undefined;

    switch (request.action) {
      case 'keep-incoming':
        winnerId = record.incomingId;
        await this.storage.update(record.existingId, { status: 'superseded' });
        break;
      case 'keep-existing':
        winnerId = record.existingId;
        await this.storage.update(record.incomingId, { status: 'superseded' });
        break;
      case 'merge':
        winnerId = record.incomingId;
        // Merge: keep incoming as winner, mark existing superseded
        await this.storage.update(record.existingId, { status: 'superseded' });
        break;
      case 'discard-both':
        await this.storage.update(record.incomingId, { status: 'archived' });
        await this.storage.update(record.existingId, { status: 'archived' });
        break;
    }

    await this.conflictStore.resolveConflict(
      request.conflictId,
      winnerId ?? null,
      request.action,
    );

    return {
      conflictId: request.conflictId,
      action: request.action,
      operatorId: request.operatorId,
      adjudicatedAt: new Date(),
      reason: request.reason,
      winnerId,
    };
  }
}
