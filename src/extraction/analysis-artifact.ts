/**
 * AnalysisArtifact — 分析中间产物（域 L）
 * FR-A01 AC5 / FR-A02 AC5：提取过程产出 Analysis Artifact，
 * 记录候选实体、概念、关联建议、冲突建议和调研建议。
 */

import { randomUUID } from 'node:crypto';
import type { KnowledgeSource, KnowledgeType } from '../types/index.js';

export type ArtifactSourceType = 'conversation' | 'document' | 'rule';

export interface CandidateEntity {
  name: string;
  type: KnowledgeType;
  confidence: number;
  content: string;
}

export interface ConceptSuggestion {
  concept: string;
  relatedEntities: string[];
}

export interface AssociationSuggestion {
  sourceContent: string;
  targetContent: string;
  relationType: string;
  confidence: number;
}

export interface ConflictSuggestion {
  existingEntryId?: string;
  existingContent: string;
  newContent: string;
  reason: string;
}

export interface ResearchSuggestion {
  topic: string;
  reason: string;
  priority: 'low' | 'medium' | 'high';
}

export interface AnalysisArtifact {
  id: string;
  sourceType: ArtifactSourceType;
  source: KnowledgeSource;
  createdAt: Date;
  candidateEntities: CandidateEntity[];
  concepts: ConceptSuggestion[];
  associationSuggestions: AssociationSuggestion[];
  conflictSuggestions: ConflictSuggestion[];
  researchSuggestions: ResearchSuggestion[];
  metadata?: Record<string, unknown>;
  /** FR-A01 AC: reasoning trace explaining extraction decisions */
  reasoning?: string;
  /** FR-A01 AC: all entities extracted before filtering */
  extractedEntities?: CandidateEntity[];
  /** FR-A01 AC: per-entity confidence breakdown */
  confidenceBreakdown?: ConfidenceBreakdownEntry[];
}

/** Per-entity confidence breakdown for Analysis Artifact (FR-A01) */
export interface ConfidenceBreakdownEntry {
  entityName: string;
  classifierConfidence: number;
  llmConfidence: number;
  finalConfidence: number;
  status: 'accepted' | 'pending_review' | 'rejected';
}

export function createAnalysisArtifact(
  sourceType: ArtifactSourceType,
  source: KnowledgeSource,
  options?: {
    candidateEntities?: CandidateEntity[];
    concepts?: ConceptSuggestion[];
    associationSuggestions?: AssociationSuggestion[];
    conflictSuggestions?: ConflictSuggestion[];
    researchSuggestions?: ResearchSuggestion[];
    metadata?: Record<string, unknown>;
    reasoning?: string;
    extractedEntities?: CandidateEntity[];
    confidenceBreakdown?: ConfidenceBreakdownEntry[];
  },
): AnalysisArtifact {
  return {
    id: randomUUID(),
    sourceType,
    source,
    createdAt: new Date(),
    candidateEntities: options?.candidateEntities ?? [],
    concepts: options?.concepts ?? [],
    associationSuggestions: options?.associationSuggestions ?? [],
    conflictSuggestions: options?.conflictSuggestions ?? [],
    researchSuggestions: options?.researchSuggestions ?? [],
    metadata: options?.metadata,
    reasoning: options?.reasoning,
    extractedEntities: options?.extractedEntities,
    confidenceBreakdown: options?.confidenceBreakdown,
  };
}
