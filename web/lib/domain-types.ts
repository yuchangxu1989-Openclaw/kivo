export type Priority = 'low' | 'medium' | 'high' | 'urgent';
export type ResearchStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
export type ResearchReferenceBatchStatus = 'extracting' | 'completed' | 'failed' | 'duplicate' | 'skipped';

export interface ResearchTask {
  id: string;
  topic: string;
  scope: string;
  priority: Priority;
  budgetCredits: number;
  expectedTypes: string[];
  status: ResearchStatus;
  createdAt: string;
  adopted?: boolean;
  highlighted?: boolean;
  resultEntryIds?: string[];
  knowledgeCount?: number;
  resultSummary?: string;
  reportPath?: string;
  reportContent?: string;
  wikiPageId?: string;
  filledGapTopic?: string;
  failureReason?: string;
}

export interface ResearchWikiEntryLink {
  id: string;
  title?: string;
  summary?: string;
}

export interface ResearchReferenceBatch {
  id: string;
  status: ResearchReferenceBatchStatus;
  sourceType?: 'local' | 'lark' | string;
  contentHash?: string;
  confirmedBy: string;
  confirmedAt?: number | string | null;
  extractedAt?: number | string | null;
  failureReason?: string | null;
  insertedCount: number;
  duplicateOfBatchId?: string;
}

export interface ResearchReport {
  id: string;
  title: string;
  reportUri: string;
  reportKind?: string;
  contentHash?: string;
  externalContentHash?: string;
  isReference: boolean;
  referenceMarkedAt?: number | string | null;
  referenceMarkedBy?: string | null;
  sourceType?: 'local' | 'lark' | string;
  failureReason?: string | null;
  batchStatus?: ResearchReferenceBatchStatus;
  insertedCount?: number;
  wikiEntryCount: number;
  wikiEntries?: ResearchWikiEntryLink[];
  entryIds?: string[];
  referenceBatches: ResearchReferenceBatch[];
}

export interface ResearchTaskRegistryItem {
  id: string;
  title: string;
  query?: string | null;
  status: ResearchStatus;
  sourceType?: string | null;
  sourceRef?: string | null;
  actorId?: string | null;
  executorId?: string | null;
  createdAt?: number | string | null;
  updatedAt?: number | string | null;
  startedAt?: number | string | null;
  completedAt?: number | string | null;
  cancelledAt?: number | string | null;
  failureReason?: string | null;
  reportPath?: string | null;
  resultPath?: string | null;
  reports: ResearchReport[];
}

export interface ResearchTopic {
  id: string;
  name: string;
  normalizedName: string;
  description?: string | null;
  createdAt?: number | string | null;
  updatedAt?: number | string | null;
  taskCount: number;
  reportCount: number;
  referenceReportCount: number;
  wikiEntryCount: number;
  tasks: ResearchTaskRegistryItem[];
}

export interface ResearchDashboardData {
  autoResearchPaused: boolean;
  tasks: ResearchTask[];
  topics: ResearchTopic[];
}


export interface ActivityEvent {
  id: string;
  eventId: string;
  type: string;
  label: string;
  summary: string;
  href?: string;
  tags?: string[];
  time: string;
  occurredAt: string;
}

export interface ActivityFilter {
  key: string;
  label: string;
}

export interface ActivityFeedData {
  filters: ActivityFilter[];
  items: ActivityEvent[];
}

export interface DictionaryEntry {
  id: string;
  term: string;
  definition: string;
  aliases: string[];
  scope: string;
  updatedAt: string;
}

export interface DictionaryData {
  entries: DictionaryEntry[];
}

export interface ConflictEntryPreview {
  id: string;
  type: string;
  content: string;
  confidence: number;
  sourceType: string;
  createdAt: string;
  updatedAt: string;
}

export interface ConflictResolutionRecord {
  operator: string;
  decidedAt: string;
  reason: string;
  strategy: 'keep_a' | 'keep_b' | 'merge' | string;
}

export interface ConflictRecordView {
  id: string;
  summaryA: string;
  summaryB: string;
  conflictType: string;
  detectedAt: string;
  status: 'unresolved' | 'resolved' | string;
  version: number;
  entryA: ConflictEntryPreview;
  entryB: ConflictEntryPreview;
  relatedEntryCount: number;
  affectedEntryIds: string[];
  mergedContent?: string;
  resolution?: ConflictResolutionRecord;
}

export interface CoverageDomain {
  name: string;
  count: number;
  trend: string;
  weak: boolean;
  hitRate: number;
}

export interface CoverageAnalyticsData {
  domains: CoverageDomain[];
}

export interface UtilizationTopItem {
  name: string;
  hits: number;
  type: string;
}

export interface MissedQuery {
  query: string;
  count: number;
}

export interface UtilizationAnalyticsData {
  topUsed: UtilizationTopItem[];
  sleepingKnowledge: string[];
  missedQueries: MissedQuery[];
}

export interface DispatchRule {
  name: string;
  subscribers: number;
  lastDistributedAt: string;
  status: string;
}

export interface FailedDispatchRule {
  name: string;
  reason: string;
}

export interface DispatchAlert {
  id?: string;
  title?: string;
  message?: string;
  createdAt?: string;
}

export interface DispatchAnalyticsData {
  activeRules: DispatchRule[];
  failedRules: FailedDispatchRule[];
  unhandledAlertCount: number;
  alerts: DispatchAlert[];
}

export interface GapSpot {
  topic: string;
  misses: number;
  suggestion: string;
  progress: string;
}

export interface LatestGapReport {
  generatedAt: string;
  weakSpots: GapSpot[];
}

export interface GapHistoryReport {
  date: string;
  title: string;
  coverage: string;
}

export interface GapReportData {
  latestReport: LatestGapReport;
  historyReports: GapHistoryReport[];
}

export interface IntentSnippet {
  id: string;
  excerpt: string;
  hitAt: string;
}

export interface IntentItem {
  id: string;
  name: string;
  description: string;
  positives: string[];
  negatives: string[];
  relatedEntryCount: number;
  recentHitCount: number;
  recentSnippets: IntentSnippet[];
  updateStatus: 'synced' | 'idle' | string;
  updatedAt: string;
}

export interface IntentData {
  items: IntentItem[];
}
