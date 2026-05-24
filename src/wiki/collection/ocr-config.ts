/**
 * FR-A02 FR-A AC3 - load enhanced OCR provider config from openclaw.json.
 *
 * Schema lives at top-level `enhancedOcr` in openclaw.json:
 *
 *   "enhancedOcr": {
 *     "provider": "openai-vision",
 *     "apiKey": "<key>",
 *     "endpoint": "https://example.com/v1",
 *     "model": "doc-ocr-pro",
 *     "lowConfidenceThreshold": 0.6,
 *     "enabled": true
 *   }
 *
 * Environment variables `ENHANCED_OCR_*` can override the file values.
 *
 * If the config block is missing or the required endpoint/apiKey pair is empty, the
 * enhanced channel stays disabled and the multimodal router runs primary OCR only.
 *
 * The intent is "config-driven, no code change, no side effects on primary path"
 * (FR-A AC3: "启用与否对其他逻辑无副作用").
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface EnhancedOcrChannelConfig {
  provider: string;
  apiKey: string;
  endpoint?: string;
  model?: string;
  lowConfidenceThreshold: number;
  enabled: boolean;
}

export interface EnhancedOcrLoadOptions {
  /** Override the openclaw.json path. Defaults to $HOME/.openclaw/openclaw.json. */
  openclawJsonPath?: string;
}

/**
 * Read the enhanced OCR channel config. Returns `null` when the channel is
 * not configured / not enabled. Never throws on missing config: missing config
 * is the dominant case.
 */
export function loadEnhancedOcrConfig(options?: EnhancedOcrLoadOptions): EnhancedOcrChannelConfig | null {
  const path = options?.openclawJsonPath
    ?? resolve(process.env.HOME ?? '/root', '.openclaw', 'openclaw.json');

  let fileEnhanced: Record<string, unknown> | undefined;
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object') {
      const root = parsed as Record<string, unknown>;
      const topLevel = root.enhancedOcr;
      if (topLevel && typeof topLevel === 'object') {
        fileEnhanced = topLevel as Record<string, unknown>;
      }
    }
  } catch {
    fileEnhanced = undefined;
  }

  const envEnhanced = readEnvEnhancedOcrConfig();
  const enhanced = { ...(fileEnhanced ?? {}), ...(envEnhanced ?? {}) };
  if (!fileEnhanced && !envEnhanced) return null;

  const provider = typeof enhanced.provider === 'string' ? enhanced.provider.trim() : 'openai-vision';
  const apiKey = typeof enhanced.apiKey === 'string' ? enhanced.apiKey.trim() : '';
  const endpoint = typeof enhanced.endpoint === 'string' ? enhanced.endpoint.trim() : undefined;
  const model = typeof enhanced.model === 'string' ? enhanced.model.trim() : 'gpt-4o-mini';
  const threshold = parseThreshold(enhanced.lowConfidenceThreshold);

  // Default `enabled` to true when endpoint and apiKey are present.
  const explicitEnabled = typeof enhanced.enabled === 'boolean' ? enhanced.enabled : undefined;
  const enabled = explicitEnabled ?? Boolean(endpoint && apiKey);

  if (!enabled || !apiKey || !endpoint) return null;

  return {
    provider,
    apiKey,
    endpoint,
    model,
    lowConfidenceThreshold: threshold,
    enabled,
  };
}

function readEnvEnhancedOcrConfig(): Record<string, unknown> | null {
  const env: Record<string, unknown> = {};
  if (process.env.ENHANCED_OCR_PROVIDER) env.provider = process.env.ENHANCED_OCR_PROVIDER;
  if (process.env.ENHANCED_OCR_API_KEY) env.apiKey = process.env.ENHANCED_OCR_API_KEY;
  if (process.env.ENHANCED_OCR_ENDPOINT) env.endpoint = process.env.ENHANCED_OCR_ENDPOINT;
  if (process.env.ENHANCED_OCR_MODEL) env.model = process.env.ENHANCED_OCR_MODEL;
  if (process.env.ENHANCED_OCR_ENABLED) {
    env.enabled = !['0', 'false', 'no', 'off'].includes(process.env.ENHANCED_OCR_ENABLED.toLowerCase());
  }
  if (process.env.ENHANCED_OCR_LOW_CONFIDENCE_THRESHOLD) {
    const parsed = Number(process.env.ENHANCED_OCR_LOW_CONFIDENCE_THRESHOLD);
    if (Number.isFinite(parsed)) env.lowConfidenceThreshold = parsed;
  }
  return Object.keys(env).length ? env : null;
}

function parseThreshold(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0.6;
}
