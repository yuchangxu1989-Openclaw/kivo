/**
 * createEmbeddingProvider — 根据配置创建对应的 EmbeddingProvider 实例
 *
 * 支持的后端：
 * - ollama: 本地 Ollama API（默认）
 * - openai-compatible: 任何 OpenAI 兼容的 /v1/embeddings 端点
 * - local: 本地 bag-of-words fallback（无需外部服务）
 *
 * 无配置时默认走 Ollama localhost:11434 + bge-m3
 */

import type { EmbeddingProvider } from './embedding-provider.js';
import type { EmbeddingBackendConfig } from '../config/types.js';
import { OllamaEmbeddingProvider } from './ollama-embedding.js';
import { OpenAIEmbedding } from './openai-embedding.js';
import { LocalEmbedding } from './local-embedding.js';

/**
 * Create an EmbeddingProvider from config.
 * Falls back to Ollama localhost:11434 with bge-m3 when no config is provided.
 */
export function createEmbeddingProvider(config?: EmbeddingBackendConfig | null): EmbeddingProvider {
  if (!config) {
    // Default: Ollama with bge-m3 on localhost
    return new OllamaEmbeddingProvider();
  }

  switch (config.provider) {
    case 'ollama':
      return new OllamaEmbeddingProvider({
        baseUrl: config.baseUrl,
        model: config.model,
      });

    case 'openai-compatible':
      if (!config.apiKey) {
        throw new Error('openai-compatible embedding provider requires apiKey');
      }
      return new OpenAIEmbedding({
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        model: config.model ?? 'text-embedding-3-small',
      });

    case 'local':
      return new LocalEmbedding(config.dimensions);

    default: {
      const exhaustive: never = config.provider;
      throw new Error(`Unknown embedding provider: ${exhaustive}`);
    }
  }
}
