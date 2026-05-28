/**
 * EmbeddingCache — LRU 缓存层
 * 包装任意 EmbeddingProvider，相同文本不重复调用。
 */

import type { EmbeddingProvider } from './embedding-provider.js';

export interface CacheStats {
  hits: number;
  misses: number;
  size: number;
  maxSize: number;
}

export class EmbeddingCache implements EmbeddingProvider {
  private readonly provider: EmbeddingProvider;
  private readonly maxSize: number;
  private readonly cache = new Map<string, number[]>();
  private hits = 0;
  private misses = 0;

  constructor(provider: EmbeddingProvider, maxSize = 1000) {
    this.provider = provider;
    this.maxSize = maxSize;
  }

  async embed(text: string): Promise<number[]> {
    const cached = this.get(text);
    if (cached) {
      this.hits++;
      return cached;
    }
    this.misses++;
    const vec = await this.provider.embed(text);
    this.set(text, vec);
    return vec;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const results: (number[] | null)[] = texts.map(t => {
      const cached = this.get(t);
      if (cached) {
        this.hits++;
        return cached;
      }
      return null;
    });

    // 收集未命中的
    const uncachedIndices: number[] = [];
    const uncachedTexts: string[] = [];
    for (let i = 0; i < results.length; i++) {
      if (results[i] === null) {
        this.misses++;
        uncachedIndices.push(i);
        uncachedTexts.push(texts[i]);
      }
    }

    if (uncachedTexts.length > 0) {
      const embeddings = await this.provider.embedBatch(uncachedTexts);
      for (let j = 0; j < uncachedIndices.length; j++) {
        const idx = uncachedIndices[j];
        results[idx] = embeddings[j];
        this.set(texts[idx], embeddings[j]);
      }
    }

    return results as number[][];
  }

  dimensions(): number {
    return this.provider.dimensions();
  }

  modelId(): string {
    return this.provider.modelId();
  }

  /** 清空缓存 */
  clear(): void {
    this.cache.clear();
    this.hits = 0;
    this.misses = 0;
  }

  /** 缓存统计 */
  stats(): CacheStats {
    return {
      hits: this.hits,
      misses: this.misses,
      size: this.cache.size,
      maxSize: this.maxSize,
    };
  }

  /** LRU get：命中时移到末尾（最近使用） */
  private get(key: string): number[] | undefined {
    const val = this.cache.get(key);
    if (val !== undefined) {
      // 移到末尾
      this.cache.delete(key);
      this.cache.set(key, val);
    }
    return val;
  }

  /** LRU set：超出容量时淘汰最早的 */
  private set(key: string, value: number[]): void {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxSize) {
      // 淘汰第一个（最久未使用）
      const firstKey = this.cache.keys().next().value!;
      this.cache.delete(firstKey);
    }
    this.cache.set(key, value);
  }
}
