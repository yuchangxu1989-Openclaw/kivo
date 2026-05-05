/**
 * SemanticSearch — 语义搜索：EmbeddingProvider + VectorIndex 组合
 * 将知识条目向量化后索引，支持自然语言查询。
 */

import type { EmbeddingProvider } from '../embedding/embedding-provider.js';
import type { KnowledgeEntry } from '../types/index.js';
import { VectorIndex, type SearchResult } from './vector-index.js';

export class SemanticSearch {
  private readonly embedding: EmbeddingProvider;
  private readonly index: VectorIndex;

  constructor(embedding: EmbeddingProvider, index: VectorIndex) {
    this.embedding = embedding;
    this.index = index;
  }

  /** 索引单条知识条目 */
  async indexEntry(entry: KnowledgeEntry): Promise<void> {
    const text = `${entry.title} ${entry.summary} ${entry.content}`;
    const vector = await this.embedding.embed(text);
    this.index.addVector(entry.id, vector);
  }

  /** 自然语言查询，返回 topK 最相关结果 */
  async search(query: string, topK: number = 10): Promise<SearchResult[]> {
    const queryVector = await this.embedding.embed(query);
    return this.index.search(queryVector, topK);
  }

  /** 批量索引 */
  async indexBatch(entries: KnowledgeEntry[]): Promise<void> {
    const texts = entries.map(e => `${e.title} ${e.summary} ${e.content}`);
    const vectors = await this.embedding.embedBatch(texts);
    for (let i = 0; i < entries.length; i++) {
      this.index.addVector(entries[i].id, vectors[i]);
    }
  }

  /** 清空索引 */
  clear(): void {
    // 重建空索引：移除所有已索引向量
    // VectorIndex 没有 clear 方法，通过搜索全部 id 逐个移除
    // 更高效的做法：直接访问 index 内部，但保持接口封装
    const allResults = this.index.search(new Array(this.embedding.dimensions()).fill(0), this.index.size());
    for (const r of allResults) {
      this.index.remove(r.id);
    }
  }
}
