/**
 * OpenAIEmbedding — OpenAI 兼容 API 实现
 * 支持任何 OpenAI 兼容端点（通过 baseUrl + apiKey 配置）。
 */

import type { EmbeddingProvider } from './embedding-provider.js';

export interface OpenAIEmbeddingConfig {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  maxBatchSize?: number;
  maxRetries?: number;
}

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'text-embedding-3-small';
const DEFAULT_MAX_BATCH = 100;
const DEFAULT_MAX_RETRIES = 3;

// text-embedding-3-small 默认 1536 维
const MODEL_DIMENSIONS: Record<string, number> = {
  'text-embedding-3-small': 1536,
  'text-embedding-3-large': 3072,
  'text-embedding-ada-002': 1536,
};

export class OpenAIEmbedding implements EmbeddingProvider {
  private readonly config: Required<Pick<OpenAIEmbeddingConfig, 'apiKey' | 'baseUrl' | 'model' | 'maxBatchSize' | 'maxRetries'>>;
  private dims: number;

  constructor(config: OpenAIEmbeddingConfig) {
    this.config = {
      apiKey: config.apiKey,
      baseUrl: (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, ''),
      model: config.model ?? DEFAULT_MODEL,
      maxBatchSize: config.maxBatchSize ?? DEFAULT_MAX_BATCH,
      maxRetries: config.maxRetries ?? DEFAULT_MAX_RETRIES,
    };
    this.dims = MODEL_DIMENSIONS[this.config.model] ?? 1536;
  }

  async embed(text: string): Promise<number[]> {
    const [result] = await this.embedBatch([text]);
    return result;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const results: number[][] = [];
    for (let i = 0; i < texts.length; i += this.config.maxBatchSize) {
      const batch = texts.slice(i, i + this.config.maxBatchSize);
      const embeddings = await this.requestWithRetry(batch);
      results.push(...embeddings);
    }
    return results;
  }

  dimensions(): number {
    return this.dims;
  }

  modelId(): string {
    return this.config.model;
  }

  private async requestWithRetry(input: string[]): Promise<number[][]> {
    let lastError: Error | undefined;
    for (let attempt = 0; attempt < this.config.maxRetries; attempt++) {
      try {
        return await this.doRequest(input);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < this.config.maxRetries - 1) {
          const delay = Math.pow(2, attempt) * 200;
          await sleep(delay);
        }
      }
    }
    throw lastError!;
  }

  private async doRequest(input: string[]): Promise<number[][]> {
    const url = `${this.config.baseUrl}/embeddings`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({ input, model: this.config.model }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`OpenAI embedding API error ${res.status}: ${body}`);
    }

    const json = await res.json() as {
      data: Array<{ embedding: number[]; index: number }>;
    };

    // API 返回可能乱序，按 index 排序
    const sorted = json.data.sort((a, b) => a.index - b.index);
    this.dims = sorted[0]?.embedding.length ?? this.dims;
    return sorted.map(d => d.embedding);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
