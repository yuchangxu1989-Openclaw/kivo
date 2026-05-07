import type { KivoConfig, EmbeddingConfig } from './types.js';

const ENV_PREFIX = 'KIVO_';

const ENV_MAP: Record<string, string> = {
  KIVO_DB_PATH: 'dbPath',
  KIVO_CONFLICT_THRESHOLD: 'conflictThreshold',
  KIVO_MODE: 'mode',
  KIVO_EMBEDDING_PROVIDER: 'embedding.provider',
  KIVO_EMBEDDING_API_KEY: 'embedding.options.apiKey',
  KIVO_EMBEDDING_MODEL: 'embedding.options.model',
  KIVO_EMBEDDING_DIMENSIONS: 'embedding.options.dimensions',
  KIVO_EMBEDDING_CACHE_SIZE: 'embedding.options.cacheSize',
};

export function loadEnvConfig(): Partial<KivoConfig> {
  const result: Partial<Record<string, unknown>> = {};

  for (const [envKey, configPath] of Object.entries(ENV_MAP)) {
    const value = process.env[envKey];
    if (value === undefined) continue;
    setNestedValue(result as Record<string, unknown>, configPath, coerceValue(configPath, value));
  }

  return result as Partial<KivoConfig>;
}

export function mergeWithEnv(fileConfig: KivoConfig): KivoConfig {
  const envConfig = loadEnvConfig();
  return deepMerge({ ...fileConfig } as Record<string, unknown>, envConfig as Record<string, unknown>) as unknown as KivoConfig;
}

export function listEnvVars(): Array<{ env: string; configPath: string; current: string | undefined }> {
  return Object.entries(ENV_MAP).map(([env, configPath]) => ({
    env,
    configPath,
    current: process.env[env],
  }));
}

function coerceValue(path: string, value: string): unknown {
  if (path === 'conflictThreshold' || path.endsWith('.dimensions') || path.endsWith('.cacheSize')) {
    const num = Number(value);
    return Number.isNaN(num) ? value : num;
  }
  return value;
}

function setNestedValue(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let current = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!(parts[i] in current) || typeof current[parts[i]] !== 'object') {
      current[parts[i]] = {};
    }
    current = current[parts[i]] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]] = value;
}

function deepMerge(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const result = { ...base };
  for (const key of Object.keys(override)) {
    if (
      override[key] !== null &&
      typeof override[key] === 'object' &&
      !Array.isArray(override[key]) &&
      result[key] !== null &&
      typeof result[key] === 'object' &&
      !Array.isArray(result[key])
    ) {
      result[key] = deepMerge(result[key] as Record<string, unknown>, override[key] as Record<string, unknown>);
    } else {
      result[key] = override[key];
    }
  }
  return result;
}
