/**
 * Workbench Types — 域 W 知识工作台数据层类型定义
 *
 * 覆盖 FR-W01 ~ FR-W12 的数据结构、查询参数、服务接口。
 */

import type {
  KnowledgeEntry,
  KnowledgeType,
  EntryStatus,
  KnowledgeSource,
  PipelineEventType,
} from '../types/index.js';
import type { ConflictRecord, ResolutionStrategy } from '../conflict/conflict-record.js';
import type { AggregatedMetrics } from '../metrics/metrics-types.js';
import type { ResearchTask } from '../research/research-task-types.js';
import type { GapPriority } from '../research/gap-detection-types.js';

// ─── FR-W01: 仪表盘总览 ─────────────────────────────────────────────────────

export interface KpiCard {
  key: string;
  label: string;
  value: number;
  previousValue?: number;
  changePercent?: number;
  trend: 'up' | 'down' | 'flat';
}

export interface DashboardOverview {
  kpiCards: KpiCard[];
  metrics: AggregatedMetrics;
  recommendedActions: DashboardRecommendation[];
}

export interface DashboardRecommendation {
  type: 'research' | 'review' | 'conflict' | 'import';
  label: string;
  description: string;
  targetPath: string;
  priority: number;
}

// ─── FR-W02: 知识列表与搜索 ──────────────────────────────────────────────────

export interface KnowledgeListFilter {
  type?: KnowledgeType | KnowledgeType[];
  status?: EntryStatus | EntryStatus[];
  source?: KnowledgeSource['type'] | KnowledgeSource['type'][];
  domain?: string | string[];
  keyword?: string;
}

export interface KnowledgeListQuery {
  filter?: KnowledgeListFilter;
  page: number;
  pageSize: number;
}

export interface KnowledgeListResult {
  items: KnowledgeEntry[];
  page: number;
  pageSize: number;
  totalPages: number;
  totalItems: number;
}

export interface SemanticSearchResult {
  entry: KnowledgeEntry;
  score: number;
  highlightSnippet?: string;
}

// ─── FR-W03: 知识条目详情 ────────────────────────────────────────────────────

export interface EntryDetail {
  entry: KnowledgeEntry;
  versionHistory: VersionRecord[];
  associations: AssociationLink[];
}

export interface VersionRecord {
  version: number;
  updatedAt: Date;
  updatedBy?: string;
  changeSummary?: string;
}

export interface VersionDiff {
  fromVersion: number;
  toVersion: number;
  changes: FieldChange[];
}

export interface FieldChange {
  field: string;
  oldValue: unknown;
  newValue: unknown;
}

export interface AssociationLink {
  targetId: string;
  targetTitle: string;
  relationType: string;
}

// ─── FR-W04: 活动流 ──────────────────────────────────────────────────────────

export type ActivityEventType =
  | 'entry:created'
  | 'entry:updated'
  | 'entry:deprecated'
  | 'conflict:detected'
  | 'conflict:resolved'
  | 'research:completed'
  | 'rule:changed';

export interface ActivityEvent {
  id: string;
  type: ActivityEventType;
  timestamp: Date;
  summary: string;
  targetId?: string;
  targetTitle?: string;
  actor?: string;
  payload?: Record<string, unknown>;
}

export interface ActivityStreamFilter {
  types?: ActivityEventType[];
}

export interface ActivityStreamQuery {
  filter?: ActivityStreamFilter;
  afterCursor?: string;
  limit?: number;
}

export interface ActivityStreamResult {
  events: ActivityEvent[];
  cursor?: string;
  hasMore: boolean;
}

export interface DateGroup {
  date: string; // ISO date YYYY-MM-DD
  events: ActivityEvent[];
}

// ─── FR-W05: 冲突裁决 ────────────────────────────────────────────────────────

export interface ConflictSummary {
  record: ConflictRecord;
  incomingSummary: string;
  existingSummary: string;
  conflictType: string;
}

export type AdjudicationAction = 'keep-incoming' | 'keep-existing' | 'merge' | 'discard-both';

export interface AdjudicationRequest {
  conflictId: string;
  action: AdjudicationAction;
  reason: string;
  operatorId: string;
}

export interface AdjudicationResult {
  conflictId: string;
  action: AdjudicationAction;
  operatorId: string;
  adjudicatedAt: Date;
  reason: string;
  winnerId?: string;
}

// ─── FR-W06: 知识条目操作 ────────────────────────────────────────────────────

export type EntryOperation = 'confirm' | 'reject' | 'deprecate';

export interface StatusChangeRequest {
  entryId: string;
  operation: EntryOperation;
  operatorId: string;
}

export interface StatusChangeResult {
  entryId: string;
  previousStatus: EntryStatus;
  newStatus: EntryStatus;
  operatorId: string;
  changedAt: Date;
}

export interface EditRequest {
  entryId: string;
  expectedVersion: number;
  patch: Partial<Pick<KnowledgeEntry, 'title' | 'content' | 'summary' | 'tags' | 'domain'>>;
  operatorId: string;
}

export interface EditResult {
  entry: KnowledgeEntry;
  newVersion: number;
  conflictDetectionTriggered: boolean;
}

export class VersionConflictError extends Error {
  constructor(
    public readonly entryId: string,
    public readonly expectedVersion: number,
    public readonly actualVersion: number,
  ) {
    super(`Version conflict on entry ${entryId}: expected ${expectedVersion}, actual ${actualVersion}`);
    this.name = 'VersionConflictError';
  }
}

// ─── FR-W07: 调研管理 ────────────────────────────────────────────────────────

export type ResearchTaskStatus = 'queued' | 'running' | 'completed' | 'cancelled' | 'failed';

export interface ResearchTaskListQuery {
  status?: ResearchTaskStatus | ResearchTaskStatus[];
  page: number;
  pageSize: number;
}

export interface ResearchTaskListResult {
  items: ResearchTaskView[];
  page: number;
  pageSize: number;
  totalPages: number;
  totalItems: number;
}

export interface ResearchTaskView {
  id: string;
  title: string;
  status: ResearchTaskStatus;
  priority: GapPriority;
  createdAt: Date;
  budgetUsed?: number;
  budgetTotal?: number;
}

export interface GapReportItem {
  gapId: string;
  topic: string;
  impactScore: number;
  fillProgress: number; // 0-1
}

export interface CreateResearchRequest {
  objective: string;
  scope: string;
  expectedKnowledgeTypes: KnowledgeType[];
  budget: { maxDurationMs: number; maxApiCalls: number };
}

// ─── FR-W08: 文档导入 ────────────────────────────────────────────────────────

export type ImportFileFormat = 'pdf' | 'markdown' | 'plaintext' | 'epub';

export const MAX_IMPORT_FILE_SIZE_BYTES = 50 * 1024 * 1024; // 50 MB

export interface ImportProgress {
  taskId: string;
  processedSegments: number;
  totalSegments: number;
  status: 'uploading' | 'extracting' | 'reviewing' | 'completed' | 'failed';
}

export interface ExtractedCandidate {
  id: string;
  type: KnowledgeType;
  title: string;
  content: string;
  sourceLocation: string; // paragraph/page reference
  accepted?: boolean;
  edited?: boolean;
}

export interface ImportSummary {
  taskId: string;
  fileName: string;
  totalExtracted: number;
  accepted: number;
  rejected: number;
  edited: number;
  importedAt: Date;
}

export interface ReviewDecision {
  candidateId: string;
  action: 'accept' | 'reject' | 'edit';
  editedContent?: string;
}

// ─── FR-W09: 系统字典管理 ────────────────────────────────────────────────────

export interface TermListQuery {
  keyword?: string;
  scope?: string;
  page: number;
  pageSize: number;
}

export interface TermListResult {
  items: TermView[];
  page: number;
  pageSize: number;
  totalPages: number;
  totalItems: number;
}

export interface TermView {
  id: string;
  term: string;
  definition: string;
  scope: string;
  aliases: string[];
}

// ─── FR-W10: 意图库管理 ──────────────────────────────────────────────────────

export interface IntentListItem {
  id: string;
  name: string;
  description: string;
  positiveCount: number;
  negativeCount: number;
  linkedEntryCount: number;
}

export interface IntentDetail {
  id: string;
  name: string;
  description: string;
  positives: string[];
  negatives: string[];
  linkedEntryIds: string[];
  matchStats?: IntentMatchStats;
  modelUpdateStatus?: 'idle' | 'updating' | 'completed' | 'failed';
}

export interface IntentMatchStats {
  last30DaysHits: number;
  typicalSnippets: string[];
}

export interface UpsertIntentRequest {
  name: string;
  description: string;
  positives: string[];
  negatives: string[];
}

// ─── FR-W11: 登录与身份 ──────────────────────────────────────────────────────

export interface LoginRequest {
  identifier: string; // nickname or email
}

export interface LoginResult {
  sessionId: string;
  userId: string;
  displayName: string;
}

// ─── FR-W12: 导航与页面发现 ──────────────────────────────────────────────────
// Covered by existing src/navigation/ module — re-exported from workbench index.

// ─── Shared: 状态机 ─────────────────────────────────────────────────────────

/** Valid status transitions for knowledge entries (FR-W06 AC2). */
export const STATUS_TRANSITIONS: Record<EntryStatus, EntryOperation[]> = {
  active: ['deprecate'],
  pending: ['confirm', 'reject'],
  rejected: [],
  draft: ['confirm'],
  deprecated: [],
  archived: [],
  superseded: [],
};

export function availableOperations(status: EntryStatus): EntryOperation[] {
  return STATUS_TRANSITIONS[status] ?? [];
}

export function resolveNewStatus(current: EntryStatus, operation: EntryOperation): EntryStatus {
  switch (operation) {
    case 'confirm':
      return 'active';
    case 'reject':
      return 'archived';
    case 'deprecate':
      return 'deprecated';
  }
}
