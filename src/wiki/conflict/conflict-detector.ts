/**
 * FR-4 AC-4.4, AC-4.8 | NFR-6
 * Conflict detector: identifies contradictions between wiki entries
 * using cosine similarity > 0.85 threshold + LLM confirmation.
 */

import type { WikiEntryRecord, LLMAdapter, EmbeddingAdapter } from '../types.js';
import type { WikiRepository } from '../db/wiki-repository.js';
import { cosineSimilarity } from '../injection/relevance-scorer.js';

export interface ConflictPair {
  entryA: WikiEntryRecord;
  entryB: WikiEntryRecord;
  similarity: number;
  isContradiction: boolean;
  llmExplanation: string;
}

export interface ConflictDetectorConfig {
  /** Cosine similarity threshold to flag as potential conflict */
  similarityThreshold: number;
  /** Max candidates to check per entry */
  maxCandidates: number;
  /** LLM model to use for contradiction confirmation */
  model: string;
}

const DEFAULT_CONFIG: ConflictDetectorConfig = {
  similarityThreshold: 0.85,
  maxCandidates: 10,
  model: 'default',
};

const CONTRADICTION_PROMPT = `你是一个知识冲突检测专家。请判断以下两段知识是否存在矛盾或冲突。

知识 A:
标题: {titleA}
内容: {contentA}

知识 B:
标题: {titleB}
内容: {contentB}

请回答:
1. 是否存在矛盾? (是/否)
2. 如果存在矛盾，简要说明矛盾点。

格式要求:
CONTRADICTION: true/false
EXPLANATION: <一句话说明>`;

export class ConflictDetector {
  private repository: WikiRepository;
  private llm: LLMAdapter;
  private embedder: EmbeddingAdapter;
  private config: ConflictDetectorConfig;

  constructor(
    repository: WikiRepository,
    llm: LLMAdapter,
    embedder: EmbeddingAdapter,
    config: Partial<ConflictDetectorConfig> = {},
  ) {
    this.repository = repository;
    this.llm = llm;
    this.embedder = embedder;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Detects conflicts for a single entry against existing knowledge base.
   * Phase 1: cosine similarity > threshold
   * Phase 2: LLM confirmation of contradiction
   */
  async detectForEntry(entry: WikiEntryRecord): Promise<ConflictPair[]> {
    if (!entry.embedding || entry.embedding.length === 0) {
      return [];
    }

    // Phase 1: Find semantically similar entries (cosine > threshold)
    const candidates = this.repository.findByVector(
      entry.embedding,
      this.config.maxCandidates,
    );

    const similarPairs: Array<{ candidate: WikiEntryRecord; similarity: number }> = [];

    for (const candidate of candidates) {
      if (candidate.id === entry.id) continue;
      if (!candidate.embedding || candidate.embedding.length === 0) continue;

      const similarity = cosineSimilarity(entry.embedding, candidate.embedding);
      if (similarity > this.config.similarityThreshold) {
        similarPairs.push({ candidate, similarity });
      }
    }

    if (similarPairs.length === 0) return [];

    // Phase 2: LLM confirmation of contradiction
    const conflicts: ConflictPair[] = [];

    for (const { candidate, similarity } of similarPairs) {
      const result = await this.checkContradiction(entry, candidate);

      if (result.isContradiction) {
        conflicts.push({
          entryA: entry,
          entryB: candidate,
          similarity,
          isContradiction: true,
          llmExplanation: result.explanation,
        });
      }
    }

    return conflicts;
  }

  /**
   * Batch scan: checks a new entry against all existing entries.
   * Intended to be called on knowledge confirmation (AC-4.8).
   */
  async detectOnIngest(newEntry: WikiEntryRecord): Promise<ConflictPair[]> {
    return this.detectForEntry(newEntry);
  }

  /**
   * Full scan: checks all entries for mutual conflicts.
   * Expensive operation, intended for periodic maintenance.
   */
  async scanAll(entries: WikiEntryRecord[]): Promise<ConflictPair[]> {
    const allConflicts: ConflictPair[] = [];
    const checkedPairs = new Set<string>();

    for (const entry of entries) {
      const conflicts = await this.detectForEntry(entry);

      for (const conflict of conflicts) {
        const pairKey = [conflict.entryA.id, conflict.entryB.id].sort().join(':');
        if (checkedPairs.has(pairKey)) continue;
        checkedPairs.add(pairKey);
        allConflicts.push(conflict);
      }
    }

    return allConflicts;
  }

  /**
   * Uses LLM to confirm whether two similar entries actually contradict each other.
   */
  private async checkContradiction(
    entryA: WikiEntryRecord,
    entryB: WikiEntryRecord,
  ): Promise<{ isContradiction: boolean; explanation: string }> {
    const prompt = CONTRADICTION_PROMPT
      .replace('{titleA}', entryA.title)
      .replace('{contentA}', entryA.content.slice(0, 1000))
      .replace('{titleB}', entryB.title)
      .replace('{contentB}', entryB.content.slice(0, 1000));

    try {
      const response = await this.llm.complete({
        model: this.config.model,
        prompt,
        content: '',
      });

      return this.parseContradictionResponse(response);
    } catch {
      // On LLM failure, conservatively mark as non-contradiction
      return { isContradiction: false, explanation: 'LLM check failed' };
    }
  }

  /**
   * Parses LLM response for contradiction determination.
   */
  private parseContradictionResponse(response: string): {
    isContradiction: boolean;
    explanation: string;
  } {
    const contradictionMatch = response.match(/CONTRADICTION:\s*(true|false)/i);
    const explanationMatch = response.match(/EXPLANATION:\s*(.+)/i);

    const isContradiction = contradictionMatch?.[1]?.toLowerCase() === 'true';
    const explanation = explanationMatch?.[1]?.trim() ?? '无法解析 LLM 响应';

    return { isContradiction, explanation };
  }
}
