export * from './types.js';
export * from './db/schema.js';
export * from './db/wiki-repository.js';
export * from './collection/url-collector.js';
export * from './collection/doc-collector.js';
export * from './collection/research-collector.js';
export * from './collection/pipeline.js';
export * from './organization/space-manager.js';
export * from './organization/directory-manager.js';
export * from './organization/link-resolver.js';
export * from './organization/louvain-scheduler.js';

// Part 2: Injection
export { cosineSimilarity as wikiCosineSimilarity, scoreEntries, RelevanceScorer as WikiRelevanceScorer } from './injection/relevance-scorer.js';
export type { ScoredEntry as WikiScoredEntry } from './injection/relevance-scorer.js';
export { estimateTokens as estimateWikiTokens, ContextBuilder } from './injection/context-builder.js';
export type { ContextFragment, InjectionContext } from './injection/context-builder.js';
export * from './injection/wiki-injector.js';
export * from './injection/injection-hook.js';

// Part 2: Search
export * from './search/search-ranker.js';
export * from './search/hybrid-search.js';
export * from './search/search-api.js';

// Part 2: Conflict
export {
  ConflictDetector as WikiConflictDetector,
} from './conflict/conflict-detector.js';
export type {
  ConflictPair as WikiConflictPair,
  ConflictDetectorConfig as WikiConflictDetectorConfig,
} from './conflict/conflict-detector.js';
export {
  ConflictResolver as WikiConflictResolver,
} from './conflict/conflict-resolver.js';
export type {
  ConflictRecord as WikiConflictRecord,
  ConflictStatus as WikiConflictStatus,
  ConflictSummary as WikiConflictSummary,
  ResolutionAction as WikiResolutionAction,
  ResolveInput as WikiResolveInput,
} from './conflict/conflict-resolver.js';
