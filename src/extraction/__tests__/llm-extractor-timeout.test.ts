import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_LLM_TIMEOUT_MS, resolveLlmTimeoutMs } from '../llm-extractor.js';

describe('OpenAILLMProvider timeout', () => {
  const originalTimeout = process.env.KIVO_LLM_TIMEOUT_MS;

  afterEach(() => {
    if (originalTimeout === undefined) {
      delete process.env.KIVO_LLM_TIMEOUT_MS;
    } else {
      process.env.KIVO_LLM_TIMEOUT_MS = originalTimeout;
    }
  });

  it('defaults each LLM chunk request to 300 seconds for slow gpt-5.5 proxy responses', () => {
    delete process.env.KIVO_LLM_TIMEOUT_MS;

    expect(DEFAULT_LLM_TIMEOUT_MS).toBe(300_000);
    expect(resolveLlmTimeoutMs()).toBe(300_000);
  });

  it('allows the per-request timeout to be overridden without changing chunk batching', () => {
    process.env.KIVO_LLM_TIMEOUT_MS = '180000';

    expect(resolveLlmTimeoutMs()).toBe(180_000);
  });
});
