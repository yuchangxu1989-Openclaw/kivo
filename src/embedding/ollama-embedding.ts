/**
 * OllamaEmbeddingProvider — 调用本地 Ollama API 进行向量化
 * 默认端点：http://localhost:11434/api/embed
 * 默认模型：bge-m3:latest（1024 维）
 */

import type { EmbeddingProvider } from './embedding-provider.js';

export interface OllamaEmbeddingConfig {
  baseUrl?: string;
  model?: string;
  maxRetries?: number;
}

const DEFAULT_BASE_URL = 'http://localhost:11434';
const DEFAULT_MODEL = 'bge-m3:latest';
const DEFAULT_MAX_RETRIES = 3;

// Known model dimensions (fallback; actual dims detected from first response)
const MODEL_DIMENSIONS: Record<string, number> = {
  'bge-m3:latest': 1024,
  'bge-m3': 1024,
  'nomic-embed-text': 768,
  'mxbai-embed-large': 1024,
  'all-minilm': 384,
};

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly maxRetries: number;
  private dims: number;

  constructor(config?: OllamaEmbeddingConfig) {
    this.baseUrl = (config?.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    this.model = config?.model ?? DEFAULT_MODEL;
    this.maxRetries = config?.maxRetries ?? DEFAULT_MAX_RETRIES;
    // Strip tag for dimension lookup
    const modelBase = this.model.replace(/:latest$/, '');
    this.dims = MODEL_DIMENSIONS[this.model] ?? MODEL_DIMENSIONS[modelBase] ?? 1024;
  }

  async embed(text: string): Promise<number[]> {
    const [result] = await this.embedBatch([text]);
    return result;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    return this.requestWithRetry(texts);
  }

  dimensions(): number {
    return this.dims;
  }

  modelId(): string {
    return this.model;
  }

  private async requestWithRetry(input: string[]): Promise<number[][]> {
    let lastError: Error | undefined;
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        return await this.doRequest(input);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < this.maxRetries - 1) {
          const delay = Math.pow(2, attempt) * 200;
          await sleep(delay);
        }
      }
    }
    throw lastError!;
  }

  private async doRequest(input: string[]): Promise<number[][]> {
    const url = `${this.baseUrl}/api/embed`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.model, input }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Ollama embedding API error ${res.status}: ${body}`);
    }

    const json = await res.json() as { embeddings: number[][] };

    if (!json.embeddings || !Array.isArray(json.embeddings)) {
      throw new Error('Ollama response missing embeddings array');
    }

    if (json.embeddings.length !== input.length) {
      throw new Error(
        `Ollama returned ${json.embeddings.length} embeddings for ${input.length} inputs`,
      );
    }

    // Update dimensions from actual response
    if (json.embeddings[0]?.length) {
      this.dims = json.embeddings[0].length;
    }

    return json.embeddings;
  }

  /**
   * Check if Ollama is reachable and has the specified model available.
   * Non-blocking check with 3s timeout.
   */
  static async isAvailable(baseUrl?: string, model?: string): Promise<boolean> {
    const url = (baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    const targetModel = (model ?? DEFAULT_MODEL).replace(/:latest$/, '');

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);

      const res = await fetch(`${url}/api/tags`, {
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!res.ok) return false;

      const json = await res.json() as { models?: Array<{ name: string }> };
      if (!json.models || !Array.isArray(json.models)) return false;

      return json.models.some(m =>
        m.name === targetModel ||
        m.name === `${targetModel}:latest` ||
        m.name.startsWith(`${targetModel}:`)
      );
    } catch {
      return false;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
