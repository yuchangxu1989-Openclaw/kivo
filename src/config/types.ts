import type { ExtractorOptions } from '../pipeline/index.js';
import type { EmbeddingProvider, LLMJudgeProvider } from '../conflict/index.js';

export interface EmbeddingConfig {
  provider: 'openai' | 'local';
  options?: {
    apiKey?: string;
    model?: string;
    dimensions?: number;
    cacheSize?: number;
  };
}

export interface ValueGateThresholds {
  /** Threshold for privacy dimension (0-1, default 0.7) */
  privacy?: number;
  /** Threshold for scenarioSpecificity dimension (0-1, default 0.7) */
  scenarioSpecificity?: number;
  /** Threshold for llmBlindSpot dimension (0-1, default 0.7) */
  llmBlindSpot?: number;
}

export interface ValueGateConfig {
  /** Dimension score thresholds — any dimension exceeding its threshold
   *  promotes the entry to high-value regardless of LLM category */
  thresholds?: ValueGateThresholds;
}

export interface KivoConfig {
  dbPath: string;
  mode?: 'standalone' | 'hosted';
  embeddingProvider?: EmbeddingProvider;
  llmProvider?: LLMJudgeProvider;
  pipelineOptions?: {
    extractor?: ExtractorOptions;
  };
  conflictThreshold?: number;
  embedding?: EmbeddingConfig;
  valueGate?: ValueGateConfig;
}

export const DEFAULT_VALUE_GATE_THRESHOLDS: Required<ValueGateThresholds> = {
  privacy: 0.7,
  scenarioSpecificity: 0.7,
  llmBlindSpot: 0.7,
};

export const DEFAULT_CONFIG: Partial<KivoConfig> = {
  dbPath: './kivo.db',
  mode: 'standalone',
  conflictThreshold: 0.80,
  valueGate: {
    thresholds: { ...DEFAULT_VALUE_GATE_THRESHOLDS },
  },
};

export function mergeConfig(userConfig: KivoConfig): KivoConfig {
  return {
    ...DEFAULT_CONFIG,
    ...userConfig,
  };
}
