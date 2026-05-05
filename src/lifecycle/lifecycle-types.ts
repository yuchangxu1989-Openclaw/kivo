import type { EntryStatus, KnowledgeEntry } from '../types/index.js';

export interface ExpiryPolicy {
  maxAgeDays: number;
  minReferenceCount: number;
  externalValidation?: boolean;
}

export type ExpiryReason = 'time_decay' | 'low_reference' | 'external_invalidation';

export interface ExpiredEntry {
  entry: KnowledgeEntry;
  reasons: ExpiryReason[];
  expiredAt: Date;
}

export interface CleanupEntry {
  knowledgeId: string;
  reason: ExpiryReason;
  previousStatus: EntryStatus;
  action: 'deprecated' | 'archived';
}

export interface CleanupReport {
  entries: CleanupEntry[];
  cleanedAt: Date;
  summary: {
    total: number;
    deprecated: number;
    archived: number;
    reasons: Record<ExpiryReason, number>;
  };
}
