export type {
  InjectionRequest,
  InjectedContextEntry,
  InjectedContextSource,
  InjectionResult,
} from './context-injection-types.js';
export { ContextInjector } from './context-injector.js';
export type { ContextInjectorOptions } from './context-injector.js';

export type {
  ClarificationSuggestion,
  DisambiguationMode,
  DisambiguationRequest,
  DisambiguationResult,
  Interpretation,
} from './disambiguation-types.js';
export { Disambiguator } from './disambiguator.js';
export type { DisambiguatorOptions } from './disambiguator.js';
export { DisambiguationInference } from './disambiguation-inference.js';
export type {
  DisambiguationInferenceRequest,
  DisambiguationInferenceResult,
} from './disambiguation-inference.js';
