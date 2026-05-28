/**
 * Dictionary Module — Barrel Export
 */

export { DictionaryService } from './dictionary-service.js';
export type { DictionaryServiceOptions } from './dictionary-service.js';

export { TermConflictChecker } from './term-conflict-checker.js';
export type { TermConflictCheckerOptions } from './term-conflict-checker.js';

export { TermInjectionStrategy } from './term-injection-strategy.js';
export type { TermInjectionStrategyOptions, TermInjectionResult } from './term-injection-strategy.js';

export { TermSearch } from './term-search.js';
export type { TermSearchOptions } from './term-search.js';

export { TermImporter } from './term-importer.js';
export type { TermImporterOptions } from './term-importer.js';

export type {
  TermMetadata,
  TermRegistrationInput,
  TermUpdatePatch,
  TermConflictResult,
  ImportReport,
  ImportDetail,
  DictionaryConfig,
  TermChangeEvent,
  TermChangeHandler,
  TermChangeEventType,
} from './term-types.js';

export {
  DEFAULT_DICTIONARY_CONFIG,
  DICTIONARY_DOMAIN,
  DICTIONARY_TAG,
} from './term-types.js';
