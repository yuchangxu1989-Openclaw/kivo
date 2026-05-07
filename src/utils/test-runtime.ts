export function isVitestRuntime(): boolean {
  return process.env.VITEST === 'true'
    || Boolean(process.env.VITEST_POOL_ID)
    || Boolean(process.env.VITEST_WORKER_ID);
}

/**
 * Unit/integration tests should not hit real LLM/BGE services by default.
 * Set KIVO_ENABLE_REAL_MODELS_IN_TEST=1 to opt back into the real path.
 */
export function shouldBypassExternalModelsInTests(): boolean {
  return isVitestRuntime() && process.env.KIVO_ENABLE_REAL_MODELS_IN_TEST !== '1';
}
