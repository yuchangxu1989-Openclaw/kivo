/**
 * SemanticRelevanceScorer — 用向量相似度替代关键词匹配的 RelevanceScorer
 * 实现与 RelevanceScorer 相同的 score() 接口，可直接替换。
 */

import type { KnowledgeEntry } from '../types/index.js';
import type { ScoredEntry } from '../injection/relevance-scorer.js';
import type { EmbeddingProvider } from '../embedding/embedding-provider.js';
import { VectorIndex } from './vector-index.js';

export interface SemanticRelevanceScorerOptions {
  embeddingProvider: EmbeddingProvider;
  keywordWeight?: number;   // 默认 0.3
  semanticWeight?: number;  // 默认 0.7
}

export class SemanticRelevanceScorer {
  private readonly embedding: EmbeddingProvider;
  private readonly keywordWeight: number;
  private readonly semanticWeight: number;
  private readonly index = new VectorIndex();
  private indexedIds = new Set<string>();

  constructor(options: SemanticRelevanceScorerOptions) {
    this.embedding = options.embeddingProvider;
    this.keywordWeight = options.keywordWeight ?? 0.3;
    this.semanticWeight = options.semanticWeight ?? 0.7;
  }

  /**
   * 对候选条目按与查询的相关性评分，返回降序排列结果。
   * 接口签名与 RelevanceScorer.score() 一致。
   */
  async score(query: string, entries: KnowledgeEntry[]): Promise<ScoredEntry[]> {
    if (entries.length === 0) return [];

    // 确保所有条目已索引
    for (const entry of entries) {
      if (!this.indexedIds.has(entry.id)) {
        const text = `${entry.title} ${entry.summary} ${entry.content}`;
        const vector = await this.embedding.embed(text);
        this.index.addVector(entry.id, vector);
        this.indexedIds.add(entry.id);
      }
    }

    // 查询向量化
    const queryVector = await this.embedding.embed(query);
    const semanticResults = this.index.search(queryVector, entries.length);
    const semanticScoreMap = new Map(semanticResults.map(r => [r.id, r.score]));

    // 关键词评分
    const queryTerms = tokenize(query);

    const scored: ScoredEntry[] = entries.map(entry => {
      const keywordScore = computeKeywordScore(queryTerms, entry);
      const semScore = semanticScoreMap.get(entry.id) ?? 0;
      const finalScore = this.keywordWeight * keywordScore + this.semanticWeight * semScore;
      return { entry, score: finalScore };
    });

    return scored.sort((a, b) => b.score - a.score);
  }
}

function tokenize(text: string): Set<string> {
  return new Set(
    text.toLowerCase().split(/\s+/).filter(w => w.length > 1)
  );
}

function computeKeywordScore(queryTerms: Set<string>, entry: KnowledgeEntry): number {
  if (queryTerms.size === 0) return 0;
  const entryText = `${entry.title} ${entry.summary} ${entry.content} ${entry.tags.join(' ')}`.toLowerCase();
  const entryTerms = new Set(entryText.split(/\s+/).filter(w => w.length > 1));
  let matches = 0;
  for (const term of queryTerms) {
    if (entryTerms.has(term)) matches++;
  }
  return matches / queryTerms.size;
}
