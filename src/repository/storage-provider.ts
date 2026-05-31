/**
 * StorageProvider — SPI 接口定义
 * 所有存储后端必须实现此接口，上层 Repository 不感知具体存储引擎。
 */

import type { KnowledgeEntry, EntryStatus, KnowledgeType } from '../types/index.js';

export interface SaveOptions {
  skipQualityGate?: boolean;
  /** Skip BGE embedding during save (deferred to batch vectorization) */
  skipEmbedding?: boolean;
  /** Skip semantic deduplication check (useful for batch imports) */
  skipDedup?: boolean;
  /** Override quality-gate semantic duplicate threshold for this save. */
  conflictThreshold?: number;
  /**
   * On BGE semantic dedup/embedding failure, retry the quality gate without
   * embedding so the caller can still write high-value knowledge.
   */
  allowWriteOnDedupError?: boolean;
  /** Timeout for the quality gate evaluation in milliseconds. */
  qualityGateTimeoutMs?: number;
}

export interface SemanticQuery {
  text: string;
  embedding?: number[];
  filters?: {
    types?: KnowledgeType[];
    status?: EntryStatus[];
    domain?: string;
    timeRange?: { from?: Date; to?: Date };
  };
  topK?: number;
  minScore?: number;
}

export interface SearchResult {
  entry: KnowledgeEntry;
  score: number;
}

/** Options for one-hop graph expansion when no dedicated graph store is wired. */
export interface GraphExpansionOptions {
  /** Max neighbours to return per seed entry. */
  limitPerSeed?: number;
}

/** A single one-hop graph neighbour returned by {@link StorageProvider.expandGraphOneHop}. */
export interface GraphExpansionResult {
  entry: KnowledgeEntry;
  /** Edge weight / association strength in [0, 1]. */
  strength: number;
  /** Raw association type label (normalized by the caller). */
  relationType: string;
  /** ID of the seed entry this neighbour was expanded from. */
  seedEntryId: string;
}

export interface StorageProvider {
  save(entry: KnowledgeEntry, options?: SaveOptions): Promise<boolean>;
  findById(id: string): Promise<KnowledgeEntry | null>;
  search(query: SemanticQuery): Promise<SearchResult[]>;
  updateStatus(id: string, status: EntryStatus): Promise<void>;
  getVersionHistory(id: string): Promise<KnowledgeEntry[]>;
  findByType(type: KnowledgeType): Promise<KnowledgeEntry[]>;
  fullTextSearch(query: string, limit?: number): Promise<KnowledgeEntry[]>;
  findAll(): Promise<KnowledgeEntry[]>;
  delete(id: string): Promise<void>;
  count(): Promise<number>;
  close(): Promise<void>;

  // ── Subject-aware injection SPI (FR-P03 AC7) ─────────────────────────────
  // Optional: implemented by storage backends that support degraded recall and
  // graph expansion. SQLite implementation lands in a follow-up (Part B).

  /** Degraded full-text recall used when vector search is unavailable. */
  fallbackFullTextSearch?(query: string, limit?: number): Promise<SearchResult[]>;
  /** One-hop graph expansion over the given seed entry IDs. */
  expandGraphOneHop?(entryIds: string[], options?: GraphExpansionOptions): Promise<GraphExpansionResult[]>;
}
