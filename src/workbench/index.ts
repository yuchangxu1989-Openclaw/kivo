/**
 * Workbench Module — 域 W 知识工作台数据层
 *
 * 聚合 FR-W01 ~ FR-W12 的类型定义和服务类。
 * FR-W09（系统字典）由 src/dictionary/ 模块覆盖。
 * FR-W11（登录与身份）由 src/auth/ 模块覆盖。
 * FR-W12（导航与页面发现）由 src/navigation/ 模块覆盖。
 */

// ── Types ──
export type {
  KpiCard,
  DashboardOverview,
  DashboardRecommendation,
  KnowledgeListFilter,
  KnowledgeListQuery,
  KnowledgeListResult,
  SemanticSearchResult,
  EntryDetail,
  VersionRecord,
  VersionDiff,
  FieldChange,
  AssociationLink,
  ActivityEventType,
  ActivityEvent,
  ActivityStreamFilter,
  ActivityStreamQuery,
  ActivityStreamResult,
  DateGroup,
  ConflictSummary,
  AdjudicationAction,
  AdjudicationRequest,
  AdjudicationResult,
  EntryOperation,
  StatusChangeRequest,
  StatusChangeResult,
  EditRequest,
  EditResult,
  ResearchTaskStatus,
  ResearchTaskListQuery,
  ResearchTaskListResult,
  ResearchTaskView,
  GapReportItem,
  CreateResearchRequest,
  ImportFileFormat,
  ImportProgress,
  ExtractedCandidate,
  ImportSummary,
  ReviewDecision,
  IntentListItem,
  IntentDetail,
  IntentMatchStats,
  UpsertIntentRequest,
  LoginRequest,
  LoginResult,
  TermListQuery,
  TermListResult,
  TermView,
} from './workbench-types.js';

export {
  VersionConflictError,
  availableOperations,
  resolveNewStatus,
  STATUS_TRANSITIONS,
  MAX_IMPORT_FILE_SIZE_BYTES,
} from './workbench-types.js';

// ── Services ──
export { DashboardService } from './dashboard-service.js';
export type { DashboardServiceDeps } from './dashboard-service.js';

export { KnowledgeListService } from './knowledge-list-service.js';
export type { KnowledgeListServiceDeps, SemanticSearchProvider } from './knowledge-list-service.js';

export { EntryDetailService } from './entry-detail-service.js';
export type { EntryDetailServiceDeps, AssociationProvider } from './entry-detail-service.js';

export { ActivityStreamService } from './activity-stream-service.js';
export type { ActivityListener } from './activity-stream-service.js';

export { ConflictAdjudicationService } from './conflict-adjudication-service.js';
export type { ConflictAdjudicationServiceDeps, ConflictStore } from './conflict-adjudication-service.js';

export { EntryOperationService } from './entry-operation-service.js';
export type { EntryOperationServiceDeps, ConflictDetectionTrigger } from './entry-operation-service.js';

export { ResearchManagementService } from './research-management-service.js';
export type { ResearchManagementServiceDeps, ResearchTaskStore, GapStore, StoredResearchTask } from './research-management-service.js';

export { DocumentImportService } from './document-import-service.js';
export type {
  ImportTask,
  ImportEvent,
  ImportEventType,
  ImportEventHandler,
  SourceLocation,
} from './document-import-service.js';

export { IntentManagementService } from './intent-management-service.js';
export type {
  IntentManagementServiceDeps,
  IntentStore,
  IntentModelUpdater,
  IntentMatchStatsProvider,
  IntentRecord,
} from './intent-management-service.js';

export { InMemoryIntentMatchStatsProvider } from './intent-match-stats-provider.js';
export type { IntentMatchEvent } from './intent-match-stats-provider.js';
