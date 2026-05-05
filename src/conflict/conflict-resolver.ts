/**
 * ConflictResolver — 冲突解决策略
 * 支持：newer-wins / confidence-wins / manual
 */

import type { KnowledgeEntry } from '../types/index.js';
import type { ConflictRecord, ResolutionStrategy } from './conflict-record.js';

export interface ResolutionResult {
  record: ConflictRecord;
  winnerId: string;
  loserId: string;
  action: 'supersede' | 'pending_manual';
}

export class ConflictResolver {
  resolve(
    record: ConflictRecord,
    incoming: KnowledgeEntry,
    existing: KnowledgeEntry,
    strategy: ResolutionStrategy
  ): ResolutionResult {
    switch (strategy) {
      case 'newer-wins': {
        const incomingTime = incoming.createdAt.getTime();
        const existingTime = existing.createdAt.getTime();
        const winnerId = incomingTime >= existingTime ? incoming.id : existing.id;
        const loserId = winnerId === incoming.id ? existing.id : incoming.id;
        return {
          record: { ...record, resolved: true, resolvedAt: new Date(), resolution: strategy, winnerId },
          winnerId,
          loserId,
          action: 'supersede',
        };
      }

      case 'confidence-wins': {
        // spec 的“来源优先（高权威来源优先）”在当前实现里映射到 confidence。
        // 约定：confidence 已包含来源权威度加权后的结果，因此按 confidence 比较即可落地来源优先。
        // 平局时保留较新的输入条目，方便新版本覆盖旧版本。
        const winnerId = incoming.confidence >= existing.confidence ? incoming.id : existing.id;
        const loserId = winnerId === incoming.id ? existing.id : incoming.id;
        return {
          record: { ...record, resolved: true, resolvedAt: new Date(), resolution: strategy, winnerId },
          winnerId,
          loserId,
          action: 'supersede',
        };
      }

      case 'manual':
        return {
          record: { ...record, resolved: false, resolution: strategy },
          winnerId: incoming.id,
          loserId: existing.id,
          action: 'pending_manual',
        };
    }
  }
}
