export type Priority = 'low' | 'medium' | 'high' | 'urgent';
export type ResearchStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

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

export interface ResearchDashboardData {
  autoResearchPaused: boolean;
  tasks: ResearchTask[];
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
