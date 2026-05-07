/**
 * LocalEmbedding — 本地 bag-of-words 向量化 fallback
 * 不依赖外部 API，用于测试和离线场景。
 * 基于词频哈希投影到固定维度空间。
 */

import type { EmbeddingProvider } from './embedding-provider.js';

const DEFAULT_DIMENSIONS = 384;

export class LocalEmbedding implements EmbeddingProvider {
  private readonly dims: number;

  constructor(dimensions?: number) {
    this.dims = dimensions ?? DEFAULT_DIMENSIONS;
  }

  async embed(text: string): Promise<number[]> {
    return this.vectorize(text);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return texts.map(t => this.vectorize(t));
  }

  dimensions(): number {
    return this.dims;
  }

  modelId(): string {
    return 'local-bow';
  }

  /**
   * 将文本投影到固定维度向量：
   * 1. 分词（空格 + 标点分割）
   * 2. 每个 token 通过哈希映射到维度索引
   * 3. 对应维度 +1（词频累加）
   * 4. L2 归一化
   */
  private vectorize(text: string): number[] {
    const vec = new Float64Array(this.dims);
    const tokens = tokenize(text);

    for (const token of tokens) {
      const idx = hashToIndex(token, this.dims);
      // 使用双哈希决定符号，减少碰撞
      const sign = hashToIndex(token + '_sign', 2) === 0 ? 1 : -1;
      vec[idx] += sign;
    }

    // L2 归一化
    let norm = 0;
    for (let i = 0; i < this.dims; i++) {
      norm += vec[i] * vec[i];
    }
    norm = Math.sqrt(norm);
    if (norm > 0) {
      for (let i = 0; i < this.dims; i++) {
        vec[i] /= norm;
      }
    }

    return Array.from(vec);
  }
}

/** 简单分词：按非字母数字字符分割，转小写，过滤空串 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fff]+/)
    .filter(t => t.length > 0);
}

/** FNV-1a 哈希映射到 [0, size) */
function hashToIndex(str: string, size: number): number {
  let hash = 2166136261;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) % size);
}
