export { ContextInjector } from './context-injector.js';
export type { ContextInjectorOptions, InjectionRequest, InjectionResponse, ScorerLike } from './context-injector.js';
export { RelevanceScorer } from './relevance-scorer.js';
export type { RelevanceScorerOptions, ScoredEntry } from './relevance-scorer.js';
export { InjectionFormatter, estimateTokens } from './injection-formatter.js';
export type { InjectionFormat, FormattedBlock, DisclosureMode } from './injection-formatter.js';
export { InjectionPolicy } from './injection-policy.js';
export type { InjectionPolicyOptions, PolicyResult } from './injection-policy.js';
// EmbeddingProvider SPI 与 conflict/spi 同构，从 injection/spi 直接 import 使用
// 不在 barrel 重导出，避免与 conflict 模块的 root-level 导出冲突
