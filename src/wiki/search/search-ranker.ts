/**
 * FR-5 AC-5.1 | NFR-2
 * Search ranker: BM25 + cosine weighted fusion using Reciprocal Rank Fusion (RRF).
 */

import type { WikiEntryRecord } from '../types.js';

export interface RankedResult {
  entry: WikiEntryRecord;
  score: number;
  /** Which sources contributed to this result */
  sources: Array<'fts' | 'vector'>;
  /** Rank position in each source list */
  ranks: { fts?: number; vector?: number };
}

export interface FusionOptions {
  /** Weight for semantic results (0-1). Default 0.6 */
  semanticWeight?: number;
  /** RRF constant k. Default 60 */
  rrfK?: number;
  /** Max results to return */
  limit?: number;
}

const DEFAULT_SEMANTIC_WEIGHT = 0.6;
const DEFAULT_RRF_K = 60;
const DEFAULT_LIMIT = 20;

export class SearchRanker {
  private defaultSemanticWeight: number;
  private rrfK: number;

  constructor(semanticWeight?: number, rrfK?: number) {
    this.defaultSemanticWeight = semanticWeight ?? DEFAULT_SEMANTIC_WEIGHT;
    this.rrfK = rrfK ?? DEFAULT_RRF_K;
  }

  /**
   * Fuses FTS5 and vector search results using weighted Reciprocal Rank Fusion.
   *
   * RRF score = weight * (1 / (k + rank))
   * Final score = ftsWeight * RRF_fts + semanticWeight * RRF_vector
   */
  fuse(
    ftsResults: WikiEntryRecord[],
    vectorResults: WikiEntryRecord[],
    options: FusionOptions = {},
  ): RankedResult[] {
    const semanticWeight = options.semanticWeight ?? this.defaultSemanticWeight;
    const ftsWeight = 1 - semanticWeight;
    const k = options.rrfK ?? this.rrfK;
    const limit = options.limit ?? DEFAULT_LIMIT;

    // Build rank maps
    const ftsRankMap = new Map<string, number>();
    ftsResults.forEach((entry, idx) => {
      ftsRankMap.set(entry.id, idx + 1);
    });

    const vectorRankMap = new Map<string, number>();
    vectorResults.forEach((entry, idx) => {
      vectorRankMap.set(entry.id, idx + 1);
    });

    // Collect all unique entries
    const entryMap = new Map<string, WikiEntryRecord>();
    for (const entry of ftsResults) entryMap.set(entry.id, entry);
    for (const entry of vectorResults) entryMap.set(entry.id, entry);

    // Compute fused scores
    const scored: RankedResult[] = [];

    for (const [id, entry] of entryMap) {
      const ftsRank = ftsRankMap.get(id);
      const vectorRank = vectorRankMap.get(id);

      let score = 0;
      const sources: Array<'fts' | 'vector'> = [];

      if (ftsRank !== undefined) {
        score += ftsWeight * (1 / (k + ftsRank));
        sources.push('fts');
      }

      if (vectorRank !== undefined) {
        score += semanticWeight * (1 / (k + vectorRank));
        sources.push('vector');
      }

      scored.push({
        entry,
        score,
        sources,
        ranks: { fts: ftsRank, vector: vectorRank },
      });
    }

    // Sort by fused score descending
    scored.sort((a, b) => b.score - a.score);

    return scored.slice(0, limit);
  }

  /**
   * Simple linear score fusion (alternative to RRF).
   * Useful when raw scores are available.
   */
  linearFuse(
    entries: Array<{ entry: WikiEntryRecord; bm25Score: number; cosineScore: number }>,
    options: FusionOptions = {},
  ): RankedResult[] {
    const semanticWeight = options.semanticWeight ?? this.defaultSemanticWeight;
    const ftsWeight = 1 - semanticWeight;
    const limit = options.limit ?? DEFAULT_LIMIT;

    const scored: RankedResult[] = entries.map(({ entry, bm25Score, cosineScore }) => ({
      entry,
      score: ftsWeight * bm25Score + semanticWeight * cosineScore,
      sources: ['fts' as const, 'vector' as const],
      ranks: {},
    }));

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }
}
