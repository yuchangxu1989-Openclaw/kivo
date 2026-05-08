export { GapDetector } from './gap-detector.js';
export type { GapDetectorOptions, KnowledgeLink } from './gap-detector.js';
export type {
  CoverageAnalysis,
  FrequencyBlindSpot,
  GapDetectionResult,
  GapPriority,
  GraphGap,
  GraphGapSignal,
  KnowledgeGap,
  KnowledgeGapType,
  QueryMissRecord,
  ResearchSuggestion,
  StructuralGap,
} from './gap-detection-types.js';
export { ResearchTaskGenerator } from './research-task-generator.js';
export type { ResearchTaskGeneratorOptions } from './research-task-generator.js';
export { ResearchExecutor } from './research-executor.js';
export type { ResearchExecutorAdapter, ResearchExecutorOptions, ResearchTaskDetail, ResearchStepDetail, ResearchTimelineEvent } from './research-executor.js';
export { WebFetchAdapter } from './web-fetch-adapter.js';
export type { WebFetchAdapterOptions, WebSearchResult } from './web-fetch-adapter.js';
export { extractUrls, extractTextFromHtml } from './web-fetch-adapter.js';
export { ResearchScheduler } from './research-scheduler.js';
export type { ResearchSchedulerOptions } from './research-scheduler.js';
export type {
  PriorityScore,
  ResearchScheduleDecision,
  SchedulerConfig,
} from './research-scheduler-types.js';
export type {
  ResearchAcquisitionMethod,
  ResearchArtifact,
  ResearchBudget,
  ResearchConsumedBudget,
  ResearchExecutionStatus,
  ResearchResult,
  ResearchScope,
  ResearchStep,
  ResearchStepResult,
  ResearchStrategy,
  ResearchTask,
} from './research-task-types.js';
