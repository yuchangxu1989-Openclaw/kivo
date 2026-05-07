import type { KivoConfig } from './types.js';

export interface ValidationError {
  field: string;
  message: string;
  suggestion: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

export function validateConfigDetailed(config: Partial<KivoConfig>): ValidationResult {
  const errors: ValidationError[] = [];

  if (!config.dbPath || typeof config.dbPath !== 'string') {
    errors.push({
      field: 'dbPath',
      message: 'dbPath is required and must be a non-empty string',
      suggestion: 'Set KIVO_DB_PATH environment variable or add dbPath to config file. Use ":memory:" for in-memory mode.',
    });
  }

  if (config.conflictThreshold !== undefined) {
    if (typeof config.conflictThreshold !== 'number' || config.conflictThreshold < 0 || config.conflictThreshold > 1) {
      errors.push({
        field: 'conflictThreshold',
        message: 'conflictThreshold must be a number between 0 and 1',
        suggestion: 'Set KIVO_CONFLICT_THRESHOLD to a value like 0.80',
      });
    }
  }

  if (config.mode && config.mode !== 'standalone' && config.mode !== 'hosted') {
    errors.push({
      field: 'mode',
      message: `Invalid mode "${config.mode}"`,
      suggestion: 'Use "standalone" or "hosted". Default is "standalone".',
    });
  }

  if (config.embedding) {
    if (config.embedding.provider !== 'openai' && config.embedding.provider !== 'local') {
      errors.push({
        field: 'embedding.provider',
        message: `Unknown embedding provider "${config.embedding.provider}"`,
        suggestion: 'Use "openai" or "local".',
      });
    }
    if (config.embedding.provider === 'openai' && !config.embedding.options?.apiKey) {
      errors.push({
        field: 'embedding.options.apiKey',
        message: 'OpenAI embedding provider requires an API key',
        suggestion: 'Set KIVO_EMBEDDING_API_KEY or add embedding.options.apiKey to config.',
      });
    }
  }

  return { valid: errors.length === 0, errors };
}

export function formatValidationErrors(result: ValidationResult): string {
  if (result.valid) return 'Configuration is valid.';
  const lines = ['Configuration errors found:\n'];
  for (const err of result.errors) {
    lines.push(`  [${err.field}] ${err.message}`);
    lines.push(`    -> ${err.suggestion}\n`);
  }
  return lines.join('\n');
}
