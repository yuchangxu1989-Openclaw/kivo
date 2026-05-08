import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { DEFAULT_CONFIG, type KivoConfig, type EmbeddingConfig } from '../config/types.js';
import { loadEnvConfig } from '../config/env-loader.js';
import { validateConfigDetailed, formatValidationErrors } from '../config/config-validator.js';

export interface ConfigCheckResult {
  valid: boolean;
  report: string;
}

export async function runConfigCheck(dir = process.cwd()): Promise<ConfigCheckResult> {
  const config = loadEffectiveConfig(dir);
  const validation = validateConfigDetailed(config);
  const lines = [formatValidationErrors(validation)];
  let valid = validation.valid;

  const embeddingCheck = await checkEmbeddingProvider(config.embedding);
  if (embeddingCheck) {
    lines.push('', embeddingCheck.message);
    if (!embeddingCheck.valid) valid = false;
  }

  return {
    valid,
    report: lines.join('\n'),
  };
}

function loadEffectiveConfig(dir: string): Partial<KivoConfig> {
  const configPath = join(resolve(dir), 'kivo.config.json');
  let fileConfig: Partial<KivoConfig> = {};

  if (existsSync(configPath)) {
    fileConfig = JSON.parse(readFileSync(configPath, 'utf-8')) as Partial<KivoConfig>;
  }

  return deepMerge(
    deepMerge({ ...DEFAULT_CONFIG } as Record<string, unknown>, fileConfig as Record<string, unknown>),
    loadEnvConfig() as Record<string, unknown>,
  ) as Partial<KivoConfig>;
}

async function checkEmbeddingProvider(embedding?: EmbeddingConfig | null): Promise<{ valid: boolean; message: string } | null> {
  if (!embedding) return null;

  if (embedding.provider === 'openai') {
    const apiKey = embedding.options?.apiKey;
    if (!apiKey) return null;

    const baseUrl = (process.env.KIVO_EMBEDDING_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/$/, '');
    const model = embedding.options?.model ?? 'text-embedding-3-small';
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      const res = await fetch(`${baseUrl}/embeddings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ model, input: 'kivo config check' }),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        return {
          valid: false,
          message: `Embedding API key check failed: HTTP ${res.status}${body ? ` — ${body.slice(0, 200)}` : ''}`,
        };
      }

      const json = await res.json() as { data?: Array<{ embedding?: unknown }> };
      const ok = Array.isArray(json.data) && Array.isArray(json.data[0]?.embedding);
      return ok
        ? { valid: true, message: 'Embedding API key check passed.' }
        : { valid: false, message: 'Embedding API key check failed: response missing embedding data.' };
    } catch (error) {
      return {
        valid: false,
        message: `Embedding API key check failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  return { valid: true, message: `Embedding provider "${embedding.provider}" does not require remote key validation.` };
}

function deepMerge(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const result = { ...base };
  for (const key of Object.keys(override)) {
    const value = override[key];
    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      result[key] !== null &&
      typeof result[key] === 'object' &&
      !Array.isArray(result[key])
    ) {
      result[key] = deepMerge(result[key] as Record<string, unknown>, value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  return result;
}
