/**
 * Shared LLM API configuration resolver for ingest/cron commands.
 *
 * Resolution order:
 * 1. Environment variables: OPENAI_API_KEY + OPENAI_BASE_URL + KIVO_LLM_MODEL
 *    (kept for compatibility; api2 image-only endpoint is skipped)
 * 2. openclaw.json → models.providers["penguin-kivo"] (dedicated KIVO key + gpt-5.5)
 *
 * No fallback: if penguin-kivo is unavailable, an explicit error is returned.
 * KIVO requires its own isolated provider so knowledge extraction/governance
 * does not contend with the main agent's communication key.
 *
 * Default model: gpt-5.5
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface LlmConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

const DEFAULT_MODEL = 'gpt-5.5';
const DEFAULT_BASE_URL = 'https://api.penguinsaichat.dpdns.org/v1';
const KIVO_PROVIDER_ID = 'penguin-kivo';

/** Ensure baseUrl ends with /v1 (OpenAI-compatible endpoint convention) */
function normalizeBaseUrl(raw: string): string {
  let url = raw.replace(/\/+$/, '');
  if (!url.endsWith('/v1')) {
    url += '/v1';
  }
  return url;
}

interface ProviderModel {
  id?: string;
  name?: string;
}

interface ProviderEntry {
  apiKey?: string;
  baseUrl?: string;
  models?: Array<ProviderModel | string>;
}

/** Extract the first model id from a provider's models array (supports object or string entries). */
function firstModelId(provider: ProviderEntry): string | undefined {
  const entry = provider.models?.[0];
  if (!entry) return undefined;
  if (typeof entry === 'string') return entry;
  return entry.id;
}

export function resolveLlmConfig(): LlmConfig | { error: string } {
  // 1. Environment variables take priority (compatibility)
  const envKey = process.env.OPENAI_API_KEY ?? '';
  const envBase = process.env.OPENAI_BASE_URL ?? '';
  const envModel = process.env.KIVO_LLM_MODEL ?? '';

  if (envKey) {
    // Skip if OPENAI_BASE_URL points to api2 (image-only endpoint)
    const isImageOnly = envBase.includes('api2.penguinsaichat');
    if (!isImageOnly) {
      return {
        apiKey: envKey,
        baseUrl: envBase || DEFAULT_BASE_URL,
        model: envModel || DEFAULT_MODEL,
      };
    }
    // api2 is image-only, fall through to the penguin-kivo provider
    console.log('[KIVO] Skipping OPENAI_API_KEY (api2 is image-only), checking openclaw.json...');
  }

  // 2. Read openclaw.json
  const ocPath = resolve(process.env.HOME ?? '/root', '.openclaw', 'openclaw.json');
  if (!existsSync(ocPath)) {
    return {
      error: `No API key configured. Set OPENAI_API_KEY environment variable or configure models.providers["${KIVO_PROVIDER_ID}"] in openclaw.json. KIVO requires LLM-based extraction — there is no offline fallback.`,
    };
  }

  let ocConfig: Record<string, unknown>;
  try {
    ocConfig = JSON.parse(readFileSync(ocPath, 'utf-8'));
  } catch {
    return { error: `Failed to parse ${ocPath}` };
  }

  const providers = (ocConfig as { models?: { providers?: Record<string, ProviderEntry> } })
    ?.models?.providers;

  if (!providers || typeof providers !== 'object') {
    return {
      error: `No models.providers found in openclaw.json. Configure models.providers["${KIVO_PROVIDER_ID}"] with an apiKey and a gpt-5.5 model.`,
    };
  }

  // Priority 0: the dedicated penguin-kivo provider (isolated key + gpt-5.5). No fallback.
  const kivoProvider = providers[KIVO_PROVIDER_ID];
  if (!kivoProvider?.apiKey) {
    return {
      error: `Provider "${KIVO_PROVIDER_ID}" not found or missing apiKey in openclaw.json. KIVO requires a dedicated provider — there is no fallback to penguin-main, openai, or any other provider.`,
    };
  }

  const resolvedBase = kivoProvider.baseUrl ? normalizeBaseUrl(kivoProvider.baseUrl) : DEFAULT_BASE_URL;
  const resolvedModel = envModel || firstModelId(kivoProvider) || DEFAULT_MODEL;
  console.log(`[KIVO] Using provider: ${KIVO_PROVIDER_ID} (baseUrl=${resolvedBase}, model=${resolvedModel})`);

  return {
    apiKey: kivoProvider.apiKey,
    baseUrl: resolvedBase,
    model: resolvedModel,
  };
}
