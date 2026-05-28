import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { DEFAULT_CONFIG, type KivoConfig, type EmbeddingBackendConfig } from '../config/types.js';
import { loadEnvConfig } from '../config/env-loader.js';
import { validateConfigDetailed, formatValidationErrors } from '../config/config-validator.js';
import { checkEmbeddingHealth } from '../embedding/health-check.js';

export interface ConfigCheckResult {
  valid: boolean;
  report: string;
}

export async function runConfigCheck(dir = process.cwd()): Promise<ConfigCheckResult> {
  const config = loadEffectiveConfig(dir);
  const validation = validateConfigDetailed(config);
  const lines = [formatValidationErrors(validation)];
  let valid = validation.valid;

  const embeddingCheck = await checkEmbeddingProviderHealth();
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

async function checkEmbeddingProviderHealth(): Promise<{ valid: boolean; message: string } | null> {
  try {
    const result = await checkEmbeddingHealth();
    return {
      valid: true,
      message: `Embedding provider "${result.provider}" (model: ${result.model}) is healthy.${result.dimensions ? ` Dimensions: ${result.dimensions}` : ''}`,
    };
  } catch (err) {
    return {
      valid: false,
      message: `Embedding health check failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
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
