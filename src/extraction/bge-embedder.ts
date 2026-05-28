/**
 * BGE Embedder — HTTP client for local BGE embedding service.
 *
 * Calls http://localhost:9876/embed for embedding generation.
 * Uses BAAI/bge-m3 (1024 dimensions) via the local HTTP service.
 *
 * Implements EmbeddingProvider interface for seamless integration.
 */

import { execSync } from 'node:child_process';
import type { EmbeddingProvider } from '../embedding/embedding-provider.js';

const BGE_SERVICE_URL = 'http://localhost:9876';
const BGE_DIMENSIONS = 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_TEXT_LENGTH = 2000;
const MAX_BATCH_SIZE = 32;

export class BgeEmbedder implements EmbeddingProvider {
  async embed(text: string): Promise<number[]> {
    const results = await this.embedBatch([text]);
    return results[0];
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const embeddings: number[][] = [];
    for (let start = 0; start < texts.length; start += MAX_BATCH_SIZE) {
      const batch = texts.slice(start, start + MAX_BATCH_SIZE);
      embeddings.push(...(await this.embedBatchChunk(batch)));
    }

    return embeddings;
  }

  private async embedBatchChunk(texts: string[]): Promise<number[][]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const resp = await fetch(`${BGE_SERVICE_URL}/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ texts: texts.map(t => t.slice(0, MAX_TEXT_LENGTH)) }),
        signal: controller.signal,
      });

      if (!resp.ok) {
        throw new Error(`BGE embed HTTP error: ${resp.status}`);
      }

      const data = (await resp.json()) as { embeddings: number[][] };
      if (!Array.isArray(data.embeddings) || data.embeddings.length !== texts.length) {
        throw new Error(
          `BGE embedding returned ${Array.isArray(data.embeddings) ? data.embeddings.length : 'non-array'} results for ${texts.length} inputs`,
        );
      }

      return data.embeddings;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`BGE request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  dimensions(): number {
    return BGE_DIMENSIONS;
  }

  modelId(): string {
    return 'bge-m3';
  }

  /** No-op: HTTP client is stateless */
  async close(): Promise<void> {}

  /** Check if the BGE HTTP service is reachable */
  static async isAvailableAsync(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5_000);
      try {
        const resp = await fetch(`${BGE_SERVICE_URL}/health`, { signal: controller.signal });
        return resp.ok;
      } finally {
        clearTimeout(timer);
      }
    } catch {
      return false;
    }
  }

  /** Synchronous availability check via health endpoint (blocking) */
  static isAvailable(): boolean {
    try {
      const result = execSync(
        `curl -s -o /dev/null -w "%{http_code}" --max-time 5 ${BGE_SERVICE_URL}/health`,
        { encoding: 'utf-8', timeout: 6_000, stdio: ['pipe', 'pipe', 'pipe'] },
      );
      return result.trim() === '200';
    } catch {
      return false;
    }
  }
}
