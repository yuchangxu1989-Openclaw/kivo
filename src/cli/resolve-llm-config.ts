/**
 * Shared LLM API configuration resolver for ingest/cron commands.
 *
 * Resolution order:
 * 1. Environment variables: OPENAI_API_KEY + OPENAI_BASE_URL + KIVO_LLM_MODEL
 * 2. openclaw.json → models.providers.penguin-main (has chat models)
 * 3. openclaw.json → first provider whose baseUrl contains 'api.penguinsaichat' with chat models
 * 4. openclaw.json → models.providers.openai (fallback)
 *
 * Default model: claude-opus-4-6
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface LlmConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

const DEFAULT_MODEL = 'claude-opus-4-6';
const DEFAULT_BASE_URL = 'https://api.penguinsaichat.dpdns.org/v1';

/** Ensure baseUrl ends with /v1 (OpenAI-compatible endpoint convention) */
function normalizeBaseUrl(raw: string): string {
  let url = raw.replace(/\/+$/, '');
  if (!url.endsWith('/v1')) {
    url += '/v1';
  }
  return url;
}

interface ProviderEntry {
  apiKey?: string;
  baseUrl?: string;
  models?: string[];
}

export function resolveLlmConfig(): LlmConfig | { error: string } {
  // 1. Environment variables take priority
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
    // api2 is image-only, fall through to openclaw.json providers
    console.log('[KIVO] Skipping OPENAI_API_KEY (api2 is image-only), checking openclaw.json...');
  }

  // 2. Read openclaw.json
  const ocPath = resolve(process.env.HOME ?? '/root', '.openclaw', 'openclaw.json');
  if (!existsSync(ocPath)) {
    return {
      error: 'No API key configured. Set OPENAI_API_KEY environment variable or configure models.providers in openclaw.json. KIVO requires LLM-based extraction — there is no offline fallback.',
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
      error: 'No models.providers found in openclaw.json. Set OPENAI_API_KEY or configure a provider with an apiKey.',
    };
  }

  // 2a. Prefer penguin-main (has chat models)
  const penguinMain = providers['penguin-main'];
  if (penguinMain?.apiKey) {
    const resolvedBase = penguinMain.baseUrl ? normalizeBaseUrl(penguinMain.baseUrl) : DEFAULT_BASE_URL;
    console.log(`[KIVO] Using provider: penguin-main (baseUrl=${resolvedBase})`);
    return {
      apiKey: penguinMain.apiKey,
      baseUrl: resolvedBase,
      model: envModel || DEFAULT_MODEL,
    };
  }

  // 2b. Find first provider with baseUrl containing 'api.penguinsaichat' (not api2) and chat models
  for (const [id, provider] of Object.entries(providers)) {
    if (
      id !== 'openai' &&
      provider?.apiKey &&
      provider.baseUrl &&
      provider.baseUrl.includes('api.penguinsaichat') &&
      !provider.baseUrl.includes('api2.penguinsaichat')
    ) {
      const resolvedBase = normalizeBaseUrl(provider.baseUrl);
      console.log(`[KIVO] Using provider: ${id} (baseUrl=${resolvedBase})`);
      return {
        apiKey: provider.apiKey,
        baseUrl: resolvedBase,
        model: envModel || DEFAULT_MODEL,
      };
    }
  }

  // 2c. Fallback to openai provider
  const openaiProvider = providers['openai'];
  if (openaiProvider?.apiKey) {
    const resolvedBase = openaiProvider.baseUrl ? normalizeBaseUrl(openaiProvider.baseUrl) : DEFAULT_BASE_URL;
    console.log(`[KIVO] Using provider: openai (baseUrl=${resolvedBase})`);
    return {
      apiKey: openaiProvider.apiKey,
      baseUrl: resolvedBase,
      model: envModel || DEFAULT_MODEL,
    };
  }

  return {
    error: 'No API key found in any provider in openclaw.json. Set OPENAI_API_KEY or add an apiKey to a provider.',
  };
}
