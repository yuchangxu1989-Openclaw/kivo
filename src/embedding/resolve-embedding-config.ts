import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { EmbeddingBackendConfig } from '../config/types.js';

const ARK_COMPAT_BASE_URL = 'http://localhost:9876/v1';
const ARK_MODEL = 'doubao-embedding-vision-251215';
const ARK_DIMENSIONS = 2048;

interface ProviderEntry {
  apiKey?: string;
  baseUrl?: string;
}

export function defaultArkEmbeddingConfig(): EmbeddingBackendConfig {
  const envApiKey = process.env.ARK_API_KEY || process.env.KIVO_EMBEDDING_API_KEY;
  const envBaseUrl = process.env.ARK_BASE_URL || process.env.KIVO_EMBEDDING_BASE_URL;
  const envModel = process.env.KIVO_EMBEDDING_MODEL;

  return {
    provider: 'openai-compatible',
    apiKey: envApiKey || readArkApiKeyFromOpenClaw() || 'local-bridge',
    baseUrl: envBaseUrl || ARK_COMPAT_BASE_URL,
    model: envModel || ARK_MODEL,
    dimensions: ARK_DIMENSIONS,
  };
}

export function readArkApiKeyFromOpenClaw(): string | null {
  const ocPath = resolve(process.env.HOME ?? '/root', '.openclaw', 'openclaw.json');
  if (!existsSync(ocPath)) return null;

  try {
    const raw = JSON.parse(readFileSync(ocPath, 'utf-8')) as {
      models?: { providers?: Record<string, ProviderEntry> };
    };
    return raw.models?.providers?.['volcengine-ark']?.apiKey?.trim() || null;
  } catch {
    return null;
  }
}

export function resolveEmbeddingConfig(
  config?: EmbeddingBackendConfig | null,
): EmbeddingBackendConfig {
  const fallback = defaultArkEmbeddingConfig();
  if (!config) return fallback;

  if (config.provider !== 'openai-compatible') {
    return config;
  }

  return {
    ...fallback,
    ...config,
    apiKey: config.apiKey || fallback.apiKey,
    baseUrl: config.baseUrl || fallback.baseUrl,
    model: config.model || fallback.model,
    dimensions: config.dimensions || fallback.dimensions,
  };
}
