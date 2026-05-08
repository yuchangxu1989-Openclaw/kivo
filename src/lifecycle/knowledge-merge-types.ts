import type { KnowledgeEntry, KnowledgeSource } from '../types/index.js';

export interface MergeCandidate {
  sourceEntryIds: string[];
  topic: string;
  similarity: number;
  requiresManualConfirmation?: boolean;
  requiresReview?: boolean;
}

export interface SourceRef {
  entryId: string;
  source: KnowledgeSource;
  extractedContent: string;
}

export interface MergedEntry extends KnowledgeEntry {
  topic: string;
  sourceRefs: SourceRef[];
  mergedAt: Date;
  reversible: true;
}

export interface MergeError {
  candidate: MergeCandidate;
  message: string;
}

export interface MergeResult {
  merged: MergedEntry[];
  skipped: MergeCandidate[];
  errors: MergeError[];
  pendingReview: MergedEntry[];
}

export interface MergeReversal {
  mergedEntryId: string;
  restoredEntryIds: string[];
  reversedAt: Date;
}

export interface MergeHistory {
  merged: MergedEntry[];
  reversals: MergeReversal[];
}
