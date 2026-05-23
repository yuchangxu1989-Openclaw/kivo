/**
 * FR-5 AC-5.1, AC-5.2 | NFR-2
 * Hybrid search: combines FTS5 full-text search with BGE-M3 semantic search.
 * Target latency: ≤500ms.
 */

import type { WikiEntryRecord, EmbeddingAdapter } from '../types.js';
import type { WikiRepository } from '../db/wiki-repository.js';
import { SearchRanker, type RankedResult } from './search-ranker.js';

export interface HybridSearchOptions {
  /** Max results to return */
  limit?: number;
  /** Scope filter */
  scope?: { spaceId?: string; directoryId?: string };
  /** Weight for semantic vs keyword (0-1, higher = more semantic) */
  semanticWeight?: number;
  /** Whether to include FTS5 results */
  enableFts?: boolean;
  /** Whether to include vector results */
  enableVector?: boolean;
  /** Maximum search budget before degrading to available partial results */
  timeoutMs?: number;
}

export interface HybridSearchResult {
  results: RankedResult[];
  totalFts: number;
  totalVector: number;
  durationMs: number;
}

const DEFAULT_LIMIT = 20;
const DEFAULT_TIMEOUT_MS = 500;

export class HybridSearch {
  private repository: WikiRepository;
  private embedder: EmbeddingAdapter;
  private ranker: SearchRanker;

  constructor(
    repository: WikiRepository,
    embedder: EmbeddingAdapter,
    ranker?: SearchRanker,
  ) {
    this.repository = repository;
    this.embedder = embedder;
    this.ranker = ranker ?? new SearchRanker();
  }

  /**
   * Executes hybrid search combining FTS5 and vector retrieval.
   */
  async search(query: string, options: HybridSearchOptions = {}): Promise<HybridSearchResult> {
    const start = performance.now();
    const limit = options.limit ?? DEFAULT_LIMIT;
    const enableFts = options.enableFts ?? true;
    const enableVector = options.enableVector ?? true;

    const timeoutAt = start + (options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    const ftsResults = enableFts ? this.ftsSearch(query, options.scope, limit * 2) : [];
    const remainingMs = timeoutAt - performance.now();
    const vectorResults = enableVector && remainingMs > 0
      ? await withTimeout(
          this.vectorSearch(query, limit * 2),
          remainingMs,
          [],
        )
      : [];

    // Apply scope filter to vector results (FTS already filtered via SQL)
    const scopedVectorResults = options.scope
      ? this.filterByScope(vectorResults, options.scope)
      : vectorResults;

    // Fuse results using ranker
    const ranked = this.ranker.fuse(
      ftsResults,
      scopedVectorResults,
      { semanticWeight: options.semanticWeight, limit },
    );

    const durationMs = performance.now() - start;

    return {
      results: ranked,
      totalFts: ftsResults.length,
      totalVector: scopedVectorResults.length,
      durationMs,
    };
  }

  /**
   * FTS5 full-text search via repository.
   */
  private ftsSearch(
    query: string,
    scope?: { spaceId?: string; directoryId?: string },
    limit: number = 40,
  ): WikiEntryRecord[] {
    return this.repository.search(query, scope).slice(0, limit);
  }

  /**
   * Semantic vector search via embedding + repository.findByVector.
   */
  private async vectorSearch(query: string, limit: number = 40): Promise<WikiEntryRecord[]> {
    const embedding = await this.embedder.embed(query);
    return this.repository.findByVector(embedding, limit);
  }

  /**
   * Filters entries by scope (space or directory).
   */
  private filterByScope(
    entries: WikiEntryRecord[],
    scope: { spaceId?: string; directoryId?: string },
  ): WikiEntryRecord[] {
    if (!scope.spaceId && !scope.directoryId) return entries;

    return entries.filter((entry) => {
      if (scope.directoryId) {
        return entry.parentId === scope.directoryId;
      }
      // For space-level filtering, check if entry belongs to the space tree
      // This is a simplified check; full tree traversal is in repository
      if (scope.spaceId) {
        return entry.parentId === scope.spaceId ||
          entry.metadata?.extra?.spaceId === scope.spaceId;
      }
      return true;
    });
  }
}


async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timeout = setTimeout(() => resolve(fallback), Math.max(0, timeoutMs));
      }),
    ]);
  } catch {
    return fallback;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
