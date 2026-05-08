import type { KnowledgeEntry, KnowledgeType } from '../types/index.js';
import type { GapPriority, KnowledgeGapType } from './gap-detection-types.js';

export type ResearchAcquisitionMethod = 'web_search' | 'document_read' | 'paper_parse';
export type ResearchExecutionStatus = 'completed' | 'budget_exceeded' | 'failed' | 'partial_success' | 'skipped';

export interface ResearchScope {
  topic: string;
  domain?: string;
  boundaries: string[];
  acquisitionMethods: ResearchAcquisitionMethod[];
}

export interface ResearchStep {
  id: string;
  method: ResearchAcquisitionMethod;
  query: string;
  rationale: string;
  limit?: number;
}

export interface ResearchStrategy {
  steps: ResearchStep[];
  searchQueries: string[];
  notes?: string;
}

export interface ResearchBudget {
  maxDurationMs: number;
  maxApiCalls: number;
}

export interface ResearchTask {
  id: string;
  gapId: string;
  gapType: KnowledgeGapType;
  title: string;
  objective: string;
  scope: ResearchScope;
  expectedKnowledgeTypes: KnowledgeType[];
  strategy: ResearchStrategy;
  completionCriteria: string[];
  budget: ResearchBudget;
  priority: GapPriority;
  impactScore: number;
  urgencyScore: number;
  blocking: boolean;
  createdAt: Date;
  scheduleAfter?: Date;
}

export interface ResearchArtifact {
  id: string;
  method: ResearchAcquisitionMethod;
  title: string;
  content: string;
  reference: string;
  metadata?: Record<string, unknown>;
}

export interface ResearchStepResult {
  artifacts: ResearchArtifact[];
  apiCallsUsed?: number;
}

export interface ResearchConsumedBudget {
  elapsedMs: number;
  apiCalls: number;
}

export interface ResearchResult {
  taskId: string;
  status: ResearchExecutionStatus;
  startedAt: Date;
  completedAt: Date;
  consumedBudget: ResearchConsumedBudget;
  artifacts: ResearchArtifact[];
  extractedEntries: KnowledgeEntry[];
  savedEntryIds: string[];
  completedStepIds: string[];
  skippedStepIds: string[];
  summary: string;
  terminationReason?: string;
  error?: string;
}
