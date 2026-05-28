/**
 * KIVO Configuration — re-exports from config/ module for backward compatibility
 */

export { type KivoConfig, type EmbeddingConfig, type ValueGateConfig, type ValueGateThresholds, DEFAULT_VALUE_GATE_THRESHOLDS, mergeConfig } from './config/types.js';
export { validateConfigDetailed, formatValidationErrors } from './config/config-validator.js';
export type { ValidationError, ValidationResult } from './config/config-validator.js';
export { loadEnvConfig, mergeWithEnv, listEnvVars } from './config/env-loader.js';

import { validateConfigDetailed, formatValidationErrors } from './config/config-validator.js';
import type { KivoConfig } from './config/types.js';

export function validateConfig(config: KivoConfig): void {
  const result = validateConfigDetailed(config);
  if (!result.valid) {
    throw new Error(formatValidationErrors(result));
  }
}
