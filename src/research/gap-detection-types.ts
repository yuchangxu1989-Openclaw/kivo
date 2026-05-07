import type { KnowledgeType } from '../types/index.js';

export type KnowledgeGapType = 'frequency_blind_spot' | 'structural_gap' | 'graph_gap';
export type GapPriority = 'high' | 'medium' | 'low';
export type GraphGapSignal = 'isolated_node' | 'sparse_community' | 'missing_bridge';

export interface QueryMissRecord {
  query: string;
  timestamp: Date;
  context?: string;
}

export interface FrequencyBlindSpot {
  pattern: string;
  hitCount: 0;
  missCount: number;
  lastMissAt: Date;
}

export interface StructuralGap {
  domain: string;
  presentTypes: KnowledgeType[];
  missingTypes: KnowledgeType[];
}

export interface GraphGap {
  signal: GraphGapSignal;
  affectedIds: string[];
  description: string;
}

export interface KnowledgeGap {
  id: string;
  type: KnowledgeGapType;
  description: string;
  priority: GapPriority;
  evidence: FrequencyBlindSpot | StructuralGap | GraphGap;
}

export interface ResearchSuggestion {
  gapId: string;
  title: string;
  description: string;
  expectedOutcome: string;
  priority: GapPriority;
}

export interface GapDetectionResult {
  gaps: KnowledgeGap[];
  suggestions: ResearchSuggestion[];
  detectedAt: Date;
}

export interface CoverageAnalysis {
  totalQueries: number;
  hitCount: number;
  missCount: number;
  hitRate: number;
  baseline: number;
  meetsBaseline: boolean;
  domainCoverage: Map<string, { total: number; covered: number; rate: number }>;
}
