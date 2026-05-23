/**
 * FR-4 AC-4.1, AC-4.5 | NFR-4
 * Cosine similarity scoring for semantic relevance via BGE-M3 embeddings.
 */

import type { WikiEntryRecord } from '../types.js';

export interface ScoredEntry {
  entry: WikiEntryRecord;
  score: number;
}

/**
 * Computes cosine similarity between two vectors.
 * Optimized dot-product without external dependencies.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(`Vector dimension mismatch: ${a.length} vs ${b.length}`);
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (denominator === 0) return 0;

  return dotProduct / denominator;
}

/**
 * Scores and filters wiki entries by semantic relevance to a query embedding.
 */
export function scoreEntries(
  entries: WikiEntryRecord[],
  queryEmbedding: number[],
  threshold: number = 0.6,
): ScoredEntry[] {
  const scored: ScoredEntry[] = [];

  for (const entry of entries) {
    if (!entry.embedding || entry.embedding.length === 0) continue;

    const score = cosineSimilarity(queryEmbedding, entry.embedding);
    if (score >= threshold) {
      scored.push({ entry, score });
    }
  }

  return scored.sort((a, b) => b.score - a.score);
}

export class RelevanceScorer {
  private threshold: number;

  constructor(threshold: number = 0.6) {
    this.threshold = threshold;
  }

  score(entries: WikiEntryRecord[], queryEmbedding: number[]): ScoredEntry[] {
    return scoreEntries(entries, queryEmbedding, this.threshold);
  }

  setThreshold(threshold: number): void {
    this.threshold = threshold;
  }
}
