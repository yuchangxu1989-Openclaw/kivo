/**
 * VectorIndex — 纯内存向量索引（适合 <10k 条目）
 * 使用余弦相似度进行最近邻搜索。
 */

import { cosineSimilarity } from "../utils/math.js";

export interface SearchResult {
  id: string;
  score: number;
}

export class VectorIndex {
  private vectors = new Map<string, number[]>();

  addVector(id: string, vector: number[]): void {
    this.vectors.set(id, vector);
  }

  search(query: number[], topK: number): SearchResult[] {
    const results: SearchResult[] = [];

    for (const [id, vec] of this.vectors) {
      const score = cosineSimilarity(query, vec);
      results.push({ id, score });
    }

    return results
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  remove(id: string): boolean {
    return this.vectors.delete(id);
  }

  size(): number {
    return this.vectors.size;
  }
}

