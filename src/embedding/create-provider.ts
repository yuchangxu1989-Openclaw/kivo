/**
 * createEmbeddingProvider — 根据配置创建对应的 EmbeddingProvider 实例
 *
 * 支持的后端：
 * - ollama: 本地 Ollama API
 * - openai-compatible: 任何 OpenAI 兼容的 /v1/embeddings 端点
 * - local: 本地 bag-of-words fallback（无需外部服务）
 *
 * 无配置时默认走方舟 doubao-embedding-vision-251215（2048 维）。
 */

import type { EmbeddingProvider } from './embedding-provider.js';
import type { EmbeddingBackendConfig } from '../config/types.js';
import { OllamaEmbeddingProvider } from './ollama-embedding.js';
import { OpenAIEmbedding } from './openai-embedding.js';
import { LocalEmbedding } from './local-embedding.js';
import { resolveEmbeddingConfig } from './resolve-embedding-config.js';

/**
 * Create an EmbeddingProvider from config.
 * Falls back to Ark doubao-embedding-vision-251215 when no config is provided.
 */
export function createEmbeddingProvider(config?: EmbeddingBackendConfig | null): EmbeddingProvider {
  const resolved = resolveEmbeddingConfig(config);

  switch (resolved.provider) {
    case 'ollama':
      return new OllamaEmbeddingProvider({
        baseUrl: resolved.baseUrl,
        model: resolved.model,
      });

    case 'openai-compatible':
      if (!resolved.apiKey) {
        throw new Error('openai-compatible embedding provider requires apiKey');
      }
      return new OpenAIEmbedding({
        apiKey: resolved.apiKey,
        baseUrl: resolved.baseUrl,
        model: resolved.model ?? 'doubao-embedding-vision-251215',
      });

    case 'local':
      return new LocalEmbedding(resolved.dimensions);

    default: {
      const exhaustive: never = resolved.provider;
      throw new Error(`Unknown embedding provider: ${exhaustive}`);
    }
  }
}
