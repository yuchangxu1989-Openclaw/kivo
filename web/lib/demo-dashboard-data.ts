/**
 * Demo Dashboard Data — Type definitions only.
 * Runtime state and CRUD functions have moved to domain-stores.ts.
 * This file is kept for backward-compatible type imports from frontend pages.
 */

export interface ActivityFilter {
  key: string;
  label: string;
}

export interface ActivityEvent {
  id: string;
  type: string;
  label: string;
  summary: string;
  time: string;
  occurredAt: string;
  href: string;
  tags: string[];
}

export interface ActivityFeedData {
  filters: ActivityFilter[];
  items: ActivityEvent[];
}

export type ResearchStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
export type Priority = '高' | '中' | '低';

export interface ResearchTask {
  id: string;
  topic: string;
  scope: string;
  status: ResearchStatus;
  priority: Priority;
  createdAt: string;
  budgetCredits: number;
  expectedTypes: string[];
  resultSummary?: string;
  knowledgeCount?: number;
  failureReason?: string;
  /** IDs of knowledge entries produced by this research */
  resultEntryIds?: string[];
  /** Which gap topic this research was meant to fill */
  filledGapTopic?: string;
}

export interface ResearchDashboardData {
  autoResearchPaused: boolean;
  tasks: ResearchTask[];
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

export interface DispatchAnalyticsData {
  activeRules: DispatchRule[];
  failedRules: FailedDispatchRule[];
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
  content: string;
  type: string;
  confidence?: number;
  sourceType?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface ConflictResolutionRecord {
  operator: string;
  decidedAt: string;
  reason: string;
  strategy: 'keep-a' | 'keep-b' | 'merge' | 'archive-both';
}

export interface ConflictRecordView {
  id: string;
  summaryA: string;
  summaryB: string;
  conflictType: string;
  detectedAt: string;
  status: 'unresolved' | 'resolved';
  version: number;
  entryA: ConflictEntryPreview;
  entryB: ConflictEntryPreview;
  mergedContent?: string;
  resolution?: ConflictResolutionRecord;
  relatedEntryCount?: number;
  affectedEntryIds?: string[];
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
  updateStatus: 'idle' | 'updating' | 'synced';
  updatedAt: string;
}

export interface IntentData {
  items: IntentItem[];
}
