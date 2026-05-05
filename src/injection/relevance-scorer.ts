/**
 * RelevanceScorer — 相关性评分
 * 基于关键词匹配 + 可选 embedding 余弦相似度
 * Embedding 不可用时降级为纯关键词匹配（权重自动调整为 1.0）
 */

import type { KnowledgeEntry } from '../types/index.js';
import type { EmbeddingProvider } from './spi.js';
import { cosineSimilarity } from '../utils/math.js';

export interface ScoredEntry {
  entry: KnowledgeEntry;
  score: number;
}

export interface RelevanceScorerOptions {
  embeddingProvider?: EmbeddingProvider;
  keywordWeight?: number;   // 默认 0.4（无 embedding 时自动 1.0）
  embeddingWeight?: number; // 默认 0.6
}

export class RelevanceScorer {
  private readonly embedding?: EmbeddingProvider;
  private readonly keywordWeight: number;
  private readonly embeddingWeight: number;

  constructor(options: RelevanceScorerOptions = {}) {
    this.embedding = options.embeddingProvider;
    this.keywordWeight = options.keywordWeight ?? 0.4;
    this.embeddingWeight = options.embeddingWeight ?? 0.6;
  }

  /**
   * 对候选条目按与查询的相关性评分，返回降序排列结果
   */
  async score(query: string, entries: KnowledgeEntry[]): Promise<ScoredEntry[]> {
    if (entries.length === 0) return [];

    const queryTerms = tokenize(query);
    let queryEmbedding: number[] | undefined;

    if (this.embedding) {
      queryEmbedding = await this.embedding.embed(query);
    }

    const scored: ScoredEntry[] = [];

    for (const entry of entries) {
      const keywordScore = computeKeywordScore(queryTerms, entry);

      let finalScore: number;
      if (this.embedding && queryEmbedding) {
        const entryText = `${entry.title} ${entry.summary} ${entry.content}`;
        const entryEmbedding = await this.embedding.embed(entryText);
        const embScore = cosineSimilarity(queryEmbedding, entryEmbedding);
        finalScore = this.keywordWeight * keywordScore + this.embeddingWeight * embScore;
      } else {
        // 无 embedding 时纯关键词
        finalScore = keywordScore;
      }

      scored.push({ entry, score: finalScore });
    }

    return scored.sort((a, b) => b.score - a.score);
  }
}

/** 分词（简易空格分词，过滤单字符噪音） */
function tokenize(text: string): Set<string> {
  return new Set(
    text.toLowerCase().split(/\s+/).filter(w => w.length > 1)
  );
}

/** 关键词命中率：查询词在条目文本中的命中比例 */
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

export { cosineSimilarity } from '../utils/math.js';
