/**
 * RelevanceScorer — 相关性评分（纯向量检索）
 * 使用 BGE embedding cosine similarity 评分。
 * BGE 始终可用，异常时报错重试，不降级。
 */

import type { KnowledgeEntry } from '../types/index.js';
import type { EmbeddingProvider } from './spi.js';
import { createEmbeddingProvider } from '../embedding/create-provider.js';
import { cosineSimilarity } from '../utils/math.js';

export interface ScoredEntry {
  entry: KnowledgeEntry;
  score: number;
}

export interface RelevanceScorerOptions {
  embeddingProvider?: EmbeddingProvider;
}

export class RelevanceScorer {
  private readonly embedding: EmbeddingProvider;

  constructor(options: RelevanceScorerOptions = {}) {
    this.embedding = options.embeddingProvider ?? createEmbeddingProvider();
  }

  /**
   * 对候选条目按与查询的 embedding 余弦相似度评分，返回降序排列结果。
   * BGE 始终可用，异常时直接抛出（由调用方处理重试）。
   */
  async score(query: string, entries: KnowledgeEntry[]): Promise<ScoredEntry[]> {
    if (entries.length === 0) return [];

    const queryEmbedding = await this.embedding.embed(query);

    const scored: ScoredEntry[] = [];

    for (const entry of entries) {
      const entryText = `${entry.title} ${entry.summary} ${entry.content}`;
      const entryEmbedding = await this.embedding.embed(entryText);
      const score = cosineSimilarity(queryEmbedding, entryEmbedding);
      scored.push({ entry, score });
    }

    return scored.sort((a, b) => b.score - a.score);
  }
}

export { cosineSimilarity } from '../utils/math.js';
