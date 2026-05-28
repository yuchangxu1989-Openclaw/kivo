/**
 * AssociationDiscovery — vector-based cross-reference discovery.
 *
 * Uses cosine similarity on BGE embeddings to find semantically related entries.
 * Replaces the previous keyword/lexical-overlap approach.
 *
 * Entries without embeddings are gracefully skipped.
 */

import type { KnowledgeEntry } from '../types/index.js';
import type { KnowledgeRepository } from '../repository/index.js';
import type { Association, AssociationType } from './association-types.js';
import { AssociationStore } from './association-store.js';

export interface DiscoveryCandidate {
  sourceId: string;
  targetId: string;
  type: AssociationType;
  strength: number;
  reason: string;
}

export interface DiscoveryOptions {
  /** Cosine similarity threshold (default: 0.75) */
  similarityThreshold?: number;
  maxCandidates?: number;
  maxScanEntries?: number;
  autoCommit?: boolean;
  /** Pre-loaded embeddings map: entryId → Float32Array vector */
  embeddings?: Map<string, Float32Array>;
}

/**
 * Compute cosine similarity between two vectors.
 * Returns 0 if either vector is zero-length or has zero magnitude.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  return dot / denom;
}

export class AssociationDiscovery {
  constructor(
    private readonly repository: KnowledgeRepository,
    private readonly store: AssociationStore
  ) {}

  /**
   * Discover semantically related entries using cosine similarity on embeddings.
   *
   * Requires embeddings to be provided via options.embeddings (pre-loaded from DB).
   * Entries without embeddings are skipped.
   */
  async discoverForEntry(
    entry: KnowledgeEntry,
    options: DiscoveryOptions = {}
  ): Promise<DiscoveryCandidate[]> {
    const threshold = options.similarityThreshold ?? 0.75;
    const maxCandidates = options.maxCandidates ?? 20;
    const embeddings = options.embeddings;

    // If no embeddings provided, gracefully return empty
    if (!embeddings || embeddings.size === 0) {
      return [];
    }

    const sourceVec = embeddings.get(entry.id);
    if (!sourceVec) {
      // Source entry has no embedding, skip
      return [];
    }

    const existing = await this.repository.findAll();
    const others = existing.filter((e) => e.id !== entry.id);

    const candidates: DiscoveryCandidate[] = [];

    for (const other of others) {
      const targetVec = embeddings.get(other.id);
      if (!targetVec) continue; // Skip entries without embeddings

      const similarity = cosineSimilarity(sourceVec, targetVec);

      if (similarity < threshold) continue;

      // Check for explicit supersedes relationship
      if (entry.supersedes === other.id) {
        candidates.push({
          sourceId: entry.id,
          targetId: other.id,
          type: 'supersedes',
          strength: 0.95,
          reason: 'explicit supersedes reference',
        });
        continue;
      }

      // Determine association type based on similarity level and metadata
      const candidate = this.classifyAssociation(entry, other, similarity);
      if (candidate) {
        candidates.push(candidate);
      }
    }

    candidates.sort((a, b) => b.strength - a.strength);
    const trimmed = candidates.slice(0, maxCandidates);

    if (options.autoCommit) {
      for (const candidate of trimmed) {
        this.store.add({
          sourceId: candidate.sourceId,
          targetId: candidate.targetId,
          type: candidate.type,
          strength: candidate.strength,
          metadata: { reason: candidate.reason, autoDiscovered: true },
        });
      }
    }

    return trimmed;
  }

  /**
   * Batch discovery: find all semantic associations across all entries.
   * More efficient than calling discoverForEntry one by one.
   */
  async discoverAll(
    options: DiscoveryOptions = {}
  ): Promise<DiscoveryCandidate[]> {
    const threshold = options.similarityThreshold ?? 0.75;
    const maxCandidates = options.maxCandidates ?? 500;
    const embeddings = options.embeddings;

    if (!embeddings || embeddings.size === 0) {
      return [];
    }

    const existing = await this.repository.findAll();
    const entriesWithEmbeddings = existing.filter((e) => embeddings.has(e.id));

    if (entriesWithEmbeddings.length < 2) {
      return [];
    }

    const candidates: DiscoveryCandidate[] = [];
    const seen = new Set<string>();

    for (let i = 0; i < entriesWithEmbeddings.length; i++) {
      const entry = entriesWithEmbeddings[i];
      const sourceVec = embeddings.get(entry.id)!;

      for (let j = i + 1; j < entriesWithEmbeddings.length; j++) {
        const other = entriesWithEmbeddings[j];
        const targetVec = embeddings.get(other.id)!;

        const similarity = cosineSimilarity(sourceVec, targetVec);
        if (similarity < threshold) continue;

        const pairKey = `${entry.id}::${other.id}`;
        if (seen.has(pairKey)) continue;
        seen.add(pairKey);

        // Check explicit supersedes
        if (entry.supersedes === other.id) {
          candidates.push({
            sourceId: entry.id,
            targetId: other.id,
            type: 'supersedes',
            strength: 0.95,
            reason: 'explicit supersedes reference',
          });
          continue;
        }

        const candidate = this.classifyAssociation(entry, other, similarity);
        if (candidate) {
          candidates.push(candidate);
        }
      }
    }

    candidates.sort((a, b) => b.strength - a.strength);
    const trimmed = candidates.slice(0, maxCandidates);

    if (options.autoCommit) {
      for (const candidate of trimmed) {
        this.store.add({
          sourceId: candidate.sourceId,
          targetId: candidate.targetId,
          type: candidate.type,
          strength: candidate.strength,
          metadata: { reason: candidate.reason, autoDiscovered: true },
        });
      }
    }

    return trimmed;
  }

  /**
   * Classify the association type based on semantic similarity and entry metadata.
   *
   * - similarity >= 0.9 + same domain + same type + newer → supersedes
   * - similarity >= 0.85 + same domain + same type → conflicts (potential duplicate)
   * - similarity >= 0.75 + same domain → supplements
   * - similarity >= 0.75 (cross-domain) → depends_on (semantic dependency)
   */
  private classifyAssociation(
    entry: KnowledgeEntry,
    other: KnowledgeEntry,
    similarity: number
  ): DiscoveryCandidate | null {
    const sameDomain = entry.domain && other.domain && entry.domain === other.domain;
    const sameType = entry.type === other.type;

    // Very high similarity + same domain + same type + newer → likely supersedes
    if (similarity >= 0.9 && sameDomain && sameType) {
      const newer = entry.createdAt > other.createdAt;
      if (newer) {
        return {
          sourceId: entry.id,
          targetId: other.id,
          type: 'supersedes',
          strength: similarity,
          reason: `high semantic similarity (${similarity.toFixed(3)}) in same domain/type, newer entry`,
        };
      }
    }

    // High similarity + same domain + same type → potential conflict
    if (similarity >= 0.85 && sameDomain && sameType) {
      return {
        sourceId: entry.id,
        targetId: other.id,
        type: 'conflicts',
        strength: similarity,
        reason: `high semantic similarity (${similarity.toFixed(3)}) in same domain/type`,
      };
    }

    // Moderate-high similarity + same domain → supplements
    if (sameDomain) {
      return {
        sourceId: entry.id,
        targetId: other.id,
        type: 'supplements',
        strength: similarity,
        reason: `semantic similarity (${similarity.toFixed(3)}) in same domain`,
      };
    }

    // Cross-domain semantic relationship → depends_on
    return {
      sourceId: entry.id,
      targetId: other.id,
      type: 'depends_on',
      strength: similarity,
      reason: `cross-domain semantic similarity (${similarity.toFixed(3)})`,
    };
  }
}
