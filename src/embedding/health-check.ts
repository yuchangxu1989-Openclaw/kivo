/**
 * Embedding Provider 健康检查
 *
 * 检测 embedding provider 是否可用：
 * - 读取配置（embedding.provider / embedding.model / embedding.baseUrl）
 * - 尝试连接并生成一个测试 embedding
 * - 不可用时抛出友好错误 + 修复引导
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EmbeddingBackendConfig } from '../config/types.js';
import { defaultArkEmbeddingConfig, resolveEmbeddingConfig } from './resolve-embedding-config.js';

export class EmbeddingNotConfiguredError extends Error {
  constructor() {
    super(
      "KIVO 需要可用的 embedding 配置。优先检查 openclaw.json 里的 volcengine-ark，或设置 ARK_API_KEY / KIVO_EMBEDDING_API_KEY。"
    );
    this.name = 'EmbeddingNotConfiguredError';
  }
}

export class EmbeddingUnreachableError extends Error {
  constructor(baseUrl: string) {
    super(
      `Embedding provider 不可达 (${baseUrl})。请确认方舟 endpoint 可访问，且 volcengine-ark apiKey 有效。`
    );
    this.name = 'EmbeddingUnreachableError';
  }
}

export class EmbeddingModelNotLoadedError extends Error {
  constructor(model: string) {
    super(`模型 ${model} 不可用。请确认使用的是方舟 doubao-embedding-vision-251215，并检查 provider 配置。`);
    this.name = 'EmbeddingModelNotLoadedError';
  }
}

export interface HealthCheckResult {
  ok: boolean;
  provider: string;
  model: string;
  baseUrl: string;
  dimensions?: number;
  error?: string;
}

/**
 * Read embedding config from kivo.config.json in the given directory.
 * Returns null if no embedding config is found.
 */
export function readEmbeddingConfig(dir?: string): EmbeddingBackendConfig | null {
  const targetDir = dir ?? process.cwd();
  const configPath = join(targetDir, 'kivo.config.json');

  if (!existsSync(configPath)) return null;

  try {
    const raw = JSON.parse(readFileSync(configPath, 'utf-8'));

    // Check for EmbeddingBackendConfig format (provider/baseUrl/model)
    if (raw.embedding?.provider && typeof raw.embedding.provider === 'string') {
      const provider = raw.embedding.provider;
      if (provider === 'ollama' || provider === 'openai-compatible' || provider === 'local') {
        return resolveEmbeddingConfig({
          provider,
          baseUrl: raw.embedding.baseUrl ?? raw.embedding.options?.baseUrl,
          model: raw.embedding.model ?? raw.embedding.options?.model,
          apiKey: raw.embedding.apiKey ?? raw.embedding.options?.apiKey,
          dimensions: raw.embedding.dimensions ?? raw.embedding.options?.dimensions,
        });
      }
      // Legacy format: provider = 'openai' maps to 'openai-compatible'
      if (provider === 'openai') {
        return resolveEmbeddingConfig({
          provider: 'openai-compatible',
          baseUrl: raw.embedding.options?.baseUrl,
          model: raw.embedding.options?.model ?? 'text-embedding-3-small',
          apiKey: raw.embedding.options?.apiKey ?? process.env.KIVO_EMBEDDING_API_KEY,
          dimensions: raw.embedding.options?.dimensions,
        });
      }
    }

    return resolveEmbeddingConfig(null);
  } catch {
    return resolveEmbeddingConfig(null);
  }
}

/**
 * Check if the embedding provider is healthy.
 * Throws a descriptive error if not.
 */
export async function checkEmbeddingHealth(dir?: string): Promise<HealthCheckResult> {
  const config = readEmbeddingConfig(dir);

  const resolved = resolveEmbeddingConfig(config ?? defaultArkEmbeddingConfig());

  if (resolved.provider === 'local') {
    return {
      ok: true,
      provider: 'local',
      model: 'bag-of-words',
      baseUrl: 'local',
      dimensions: resolved.dimensions ?? 128,
    };
  }

  if (resolved.provider === 'ollama') {
    const baseUrl = resolved.baseUrl ?? 'http://localhost:11434';
    const model = resolved.model ?? 'bge-m3:latest';
    return checkOllamaHealth(baseUrl, model);
  }

  if (resolved.provider === 'openai-compatible') {
    const baseUrl = resolved.baseUrl ?? 'https://ark.cn-beijing.volces.com/api/v3';
    const model = resolved.model ?? 'doubao-embedding-vision-251215';
    return checkOpenAICompatibleHealth(baseUrl, model, resolved.apiKey);
  }

  throw new EmbeddingNotConfiguredError();
}

/**
 * Check Ollama health: reachability + model availability + test embedding.
 */
async function checkOllamaHealth(baseUrl: string, model: string): Promise<HealthCheckResult> {
  const url = baseUrl.replace(/\/$/, '');

  // Step 1: Check reachability
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`${url}/api/tags`, { signal: controller.signal });
    clearTimeout(timeout);

    if (!res.ok) {
      throw new EmbeddingUnreachableError(url);
    }

    // Step 2: Check model availability
    const json = await res.json() as { models?: Array<{ name: string }> };
    const modelBase = model.replace(/:latest$/, '');
    const hasModel = json.models?.some(m =>
      m.name === model || m.name === modelBase || m.name === `${modelBase}:latest` || m.name.startsWith(`${modelBase}:`)
    ) ?? false;

    if (!hasModel) {
      throw new EmbeddingModelNotLoadedError(model);
    }

    // Step 3: Test embedding generation
    const testController = new AbortController();
    const testTimeout = setTimeout(() => testController.abort(), 15000);
    const testRes = await fetch(`${url}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input: ['health check'] }),
      signal: testController.signal,
    });
    clearTimeout(testTimeout);

    if (!testRes.ok) {
      const body = await testRes.text().catch(() => '');
      throw new EmbeddingModelNotLoadedError(model);
    }

    const testJson = await testRes.json() as { embeddings?: number[][] };
    const dims = testJson.embeddings?.[0]?.length;

    return {
      ok: true,
      provider: 'ollama',
      model,
      baseUrl: url,
      dimensions: dims,
    };
  } catch (err) {
    if (err instanceof EmbeddingUnreachableError || err instanceof EmbeddingModelNotLoadedError) {
      throw err;
    }
    if (err instanceof Error && err.name === 'AbortError') {
      throw new EmbeddingUnreachableError(url);
    }
    throw new EmbeddingUnreachableError(url);
  }
}

/**
 * Check OpenAI-compatible endpoint health.
 */
async function checkOpenAICompatibleHealth(baseUrl: string, model: string, apiKey?: string): Promise<HealthCheckResult> {
  const url = baseUrl.replace(/\/$/, '');

  if (!apiKey) {
    throw new EmbeddingNotConfiguredError();
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const res = await fetch(`${url}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model, input: 'health check' }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      if (res.status === 401 || res.status === 403) {
        throw new Error(
          `Embedding API 认证失败 (${res.status})。请检查 API key 是否正确。`
        );
      }
      throw new EmbeddingUnreachableError(url);
    }

    const json = await res.json() as { data?: Array<{ embedding: number[] }> };
    const dims = json.data?.[0]?.embedding?.length;

    return {
      ok: true,
      provider: 'openai-compatible',
      model,
      baseUrl: url,
      dimensions: dims,
    };
  } catch (err) {
    if (err instanceof EmbeddingUnreachableError || err instanceof EmbeddingNotConfiguredError) {
      throw err;
    }
    if (err instanceof Error && (err.name === 'AbortError' || err.message.includes('fetch'))) {
      throw new EmbeddingUnreachableError(url);
    }
    throw err;
  }
}
