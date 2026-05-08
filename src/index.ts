export * from './types/index.js';
export * from './association/index.js';
export * from './pipeline/index.js';
export { ConflictDetector, cosineSimilarity, keywordOverlap, ConflictResolver, ConflictResolutionLog } from './conflict/index.js';
export type { ConflictDetectorOptions, ResolutionResult, ConflictRecord, ConflictVerdict, ResolutionStrategy, LLMJudgeProvider, ResolutionLogEntry } from './conflict/index.js';
export * from './repository/index.js';
export * from './storage/index.js';
export * from './injection/index.js';
export {
  ContextInjector as IntentContextInjector,
  Disambiguator,
  DisambiguationInference,
} from './intent/index.js';
export type {
  ContextInjectorOptions as IntentContextInjectorOptions,
  InjectionRequest as IntentInjectionRequest,
  InjectedContextEntry,
  InjectedContextSource,
  InjectionResult as IntentInjectionResult,
  ClarificationSuggestion,
  DisambiguationMode,
  DisambiguationRequest,
  DisambiguationResult,
  Interpretation,
  DisambiguatorOptions,
  DisambiguationInferenceRequest,
  DisambiguationInferenceResult,
} from './intent/index.js';
export {
  ConversationExtractor,
  type ConversationExtractorOptions,
  type ConversationExtractionResult,
  type ConversationMessage,
  MarkdownParser,
  PlainTextParser,
  type DocumentParser,
  type ParsedSection,
  type Frontmatter,
  DocumentExtractor,
  detectDocumentFormat,
  type DocumentExtractorOptions,
  type DocumentExtractionResult,
  type DocumentMetadata,
  type DocumentFormat,
  RuleExtractor,
  type RuleEntry,
  type RuleExtractorOptions,
  type RulePriority,
  type RuleChangeEvent,
  type RuleConflict,
  ExtractionPipeline,
  type ExtractionPipelineOptions,
  ChunkStrategy,
  type ChunkOptions,
  type Chunk,
  createAnalysisArtifact,
  // AnalysisArtifact excluded — exported from pipeline
  type ArtifactSourceType,
  type CandidateEntity,
  type ConceptSuggestion,
  type AssociationSuggestion,
  type ConflictSuggestion,
  // ResearchSuggestion excluded — exported from research
  PersonalKnowledgeInput,
  type PersonalKnowledgeInputOptions,
  type ManualEntryInput,
  type FileImportInput,
  type UrlImportInput,
  type ConversationMarkInput,
  type BatchFolderInput,
  type BatchImportProgress,
  type ProgressCallback,
} from './extraction/index.js';
export type { AnalysisArtifact as ExtractionAnalysisArtifact, ResearchSuggestion as ExtractionResearchSuggestion } from './extraction/index.js';
export * from './rules/index.js';
export * from './subscription/index.js';
export * from './distribution/index.js';
export * from './adapter/index.js';
export * from './embedding/index.js';
export {
  ExpiryDetector,
  CleanupManager,
  KnowledgeMerger,
  type CleanupEntry,
  type CleanupReport,
  type ExpiredEntry,
  type ExpiryPolicy,
  type ExpiryReason,
  // MergeCandidate excluded — exported from pipeline
  type MergeError,
  type MergeHistory,
  type MergedEntry,
  type MergeResult,
  type MergeReversal,
  type SourceRef,
} from './lifecycle/index.js';
export type { MergeCandidate as LifecycleMergeCandidate } from './lifecycle/index.js';
export * from './dictionary/index.js';
export {
  GapDetector,
  type GapDetectorOptions,
  type KnowledgeLink,
  type CoverageAnalysis,
  type FrequencyBlindSpot,
  type GapDetectionResult,
  type GapPriority,
  type GraphGap,
  type GraphGapSignal,
  type KnowledgeGap,
  type KnowledgeGapType,
  type QueryMissRecord,
  type ResearchSuggestion,
  type StructuralGap,
  ResearchTaskGenerator,
  type ResearchTaskGeneratorOptions,
  ResearchExecutor,
  type ResearchExecutorAdapter,
  type ResearchExecutorOptions,
  type ResearchTaskDetail,
  type ResearchStepDetail,
  type ResearchTimelineEvent,
  WebFetchAdapter,
  type WebFetchAdapterOptions,
  extractUrls,
  extractTextFromHtml,
  ResearchScheduler,
  type ResearchSchedulerOptions,
  type PriorityScore,
  type ResearchScheduleDecision,
  type SchedulerConfig,
  type ResearchAcquisitionMethod,
  type ResearchArtifact,
  type ResearchBudget,
  type ResearchConsumedBudget,
  type ResearchExecutionStatus,
  type ResearchResult,
  type ResearchScope,
  type ResearchStep,
  type ResearchStepResult,
  type ResearchStrategy,
  type ResearchTask,
} from './research/index.js';
export { VectorIndex, cosineSimilarity as vectorCosineSimilarity, SemanticSearch, SemanticRelevanceScorer } from './search/index.js';
export type { SearchResult as VectorSearchResult, SemanticRelevanceScorerOptions } from './search/index.js';
export { Kivo, type IngestResult } from './kivo.js';
export { type KivoConfig, type EmbeddingConfig, mergeConfig, validateConfig } from './config.js';
export { validateConfigDetailed, formatValidationErrors, type ValidationError, type ValidationResult } from './config/config-validator.js';
export { loadEnvConfig, mergeWithEnv, listEnvVars } from './config/env-loader.js';
export { detectCapabilities, formatCapabilities, type SystemCapabilities, type ComponentStatus, type ComponentName } from './cli/capabilities.js';
export { runHealthCheck, formatHealthReport, type HealthReport, type HealthCheckItem } from './cli/health-check.js';
export * from './errors/index.js';
export * from './bootstrap/index.js';
export * from './onboarding/index.js';
export * from './auth/index.js';
export * from './navigation/index.js';
export * from './workbench/index.js';
export * from './doc-gate/index.js';
export * from './domain-goal/index.js';
export * from './access-control/index.js';
export * from './metrics/index.js';
export * from './bulk-export/index.js';
export {
  BulkImporter,
  type BulkImportTarget,
  type ImportReport as BulkImportReport,
  type ImportError as BulkImportError,
  type ImportOptions as BulkImportOptions,
  type ImportValidationResult,
  COMPATIBLE_FORMAT_VERSIONS,
} from './bulk-import/index.js';
export * from './doc-package/index.js';
export * from './migration/index.js';
export { checkEnvironment, formatEnvCheckReport, SUPPORT_MATRIX, type EnvCheckReport, type EnvCheckItem, type SupportMatrix } from './cli/install-validator.js';

export { resolveSecrets, checkSecrets, maskSecret, formatSecretReport, type SecretCheckResult, type SecretCheckReport } from './config/secret-manager.js';
