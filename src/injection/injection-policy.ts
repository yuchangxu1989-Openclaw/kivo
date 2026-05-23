/**
 * InjectionPolicy — 注入策略
 * 控制 token 预算、优先级排序（类型偏好 + 评分）、去重
 */

import type { KnowledgeType } from '../types/index.js';
import type { FormattedBlock } from './injection-formatter.js';
import type { ScoredEntry } from './relevance-scorer.js';

export interface InjectionPolicyOptions {
  maxTokens: number;
  preferredTypes?: KnowledgeType[];
  minScore?: number;              // 默认 0.1
  deduplicateThreshold?: number;  // 标题相似度去重阈值，默认 0.8
}

export interface PolicyResult {
  selected: FormattedBlock[];
  tokensUsed: number;
  truncated: boolean;
  droppedCount: number;
}

export class InjectionPolicy {
  private readonly maxTokens: number;
  private readonly preferredTypes: KnowledgeType[];
  private readonly minScore: number;
  private readonly deduplicateThreshold: number;

  constructor(options: InjectionPolicyOptions) {
    this.maxTokens = options.maxTokens;
    this.preferredTypes = options.preferredTypes ?? [];
    this.minScore = options.minScore ?? 0.1;
    this.deduplicateThreshold = options.deduplicateThreshold ?? 0.8;
  }

  apply(scored: ScoredEntry[], blocks: FormattedBlock[]): PolicyResult {
    const blockMap = new Map<string, FormattedBlock>();
    for (const block of blocks) {
      blockMap.set(block.entryId, block);
    }

    // 1. Filter by minimum score
    let filtered = scored.filter(s => s.score >= this.minScore);

    // 2. Deduplicate by title similarity
    filtered = this.deduplicate(filtered);

    // 3. Sort: terminology first (FR-E01-AC4), then preferred types, then by score descending
    filtered.sort((a, b) => {
      const aDict = a.entry.domain === 'system-dictionary' ? 1 : 0;
      const bDict = b.entry.domain === 'system-dictionary' ? 1 : 0;
      if (aDict !== bDict) return bDict - aDict;
      const aPref = this.preferredTypes.includes(a.entry.type) ? 1 : 0;
      const bPref = this.preferredTypes.includes(b.entry.type) ? 1 : 0;
      if (aPref !== bPref) return bPref - aPref;
      return b.score - a.score;
    });

    // 4. Select within token budget
    const selected: FormattedBlock[] = [];
    let tokensUsed = 0;
    let totalCandidates = 0;

    for (const item of filtered) {
      const block = blockMap.get(item.entry.id);
      if (!block) continue;
      totalCandidates++;

      if (tokensUsed + block.estimatedTokens <= this.maxTokens) {
        selected.push(block);
        tokensUsed += block.estimatedTokens;
      }
    }

    return {
      selected,
      tokensUsed,
      truncated: selected.length < totalCandidates,
      droppedCount: totalCandidates - selected.length,
    };
  }

  private deduplicate(entries: ScoredEntry[]): ScoredEntry[] {
    const result: ScoredEntry[] = [];
    const seenIds = new Set<string>();

    for (const item of entries) {
      if (seenIds.has(item.entry.id)) continue;

      const isDuplicate = result.some(existing =>
        titleSimilarity(existing.entry.title, item.entry.title) >= this.deduplicateThreshold
      );

      if (!isDuplicate) {
        result.push(item);
        seenIds.add(item.entry.id);
      }
    }

    return result;
  }
}

/** 标题词级相似度（用于去重判定） */
function titleSimilarity(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().split(/\s+/).filter(Boolean));
  const wordsB = new Set(b.toLowerCase().split(/\s+/).filter(Boolean));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let overlap = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) overlap++;
  }
  return overlap / Math.max(wordsA.size, wordsB.size);
}
