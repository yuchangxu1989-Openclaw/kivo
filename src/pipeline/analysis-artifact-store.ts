/**
 * Analysis Artifact Store — 分析中间产物存储 + 审核队列
 * FR-L01, FR-L02
 */

import { randomUUID } from 'node:crypto';
import type { KnowledgeType } from '../types/index.js';
import type { ResearchTask } from '../research/research-task-types.js';

export type AnalysisArtifactStatus = 'ready' | 'pending_review' | 'approved' | 'rejected';
export type AnalysisCandidateAction = 'approved' | 'rejected' | 'edited';

export interface AnalysisClaim {
  id: string;
  text: string;
  confidence: number;
  type?: KnowledgeType;
}

export interface AnalysisCandidate {
  id: string;
  label: string;
  confidence: number;
  payload?: Record<string, unknown>;
}

export interface ReviewCandidate {
  id: string;
  field:
    | 'extractedClaims'
    | 'entityCandidates'
    | 'conceptCandidates'
    | 'linkCandidates'
    | 'conflictCandidates'
    | 'gapCandidates'
    | 'recommendedResearchQueries';
  candidateId: string;
  reason: string;
  confidence: number;
}

export interface ArtifactCandidateDecision {
  candidateId: string;
  action: AnalysisCandidateAction;
  editedValue?: string;
  note?: string;
}

export interface CandidateReviewRecord extends ArtifactCandidateDecision {
  reviewedAt: Date;
}

export interface AnalysisArtifactInput {
  sourceId: string;
  pipelineId?: string;
  extractedClaims: AnalysisClaim[];
  entityCandidates: AnalysisCandidate[];
  conceptCandidates: AnalysisCandidate[];
  linkCandidates: AnalysisCandidate[];
  conflictCandidates: AnalysisCandidate[];
  gapCandidates: AnalysisCandidate[];
  reviewCandidates: ReviewCandidate[];
  recommendedResearchQueries: string[];
  confidence?: number;
}

export interface AnalysisArtifact extends AnalysisArtifactInput {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  status: AnalysisArtifactStatus;
  candidateDecisions: CandidateReviewRecord[];
}

export interface ArtifactReviewQueueItem {
  artifactId: string;
  sourceId: string;
  queuedAt: Date;
  reviewCount: number;
}

export interface ArtifactToResearchTaskOptions {
  artifactId: string;
  priority?: ResearchTask['priority'];
  createdAt?: Date;
}

export class AnalysisArtifactStore {
  private readonly artifacts = new Map<string, AnalysisArtifact>();
  private readonly reviewQueue = new Map<string, ArtifactReviewQueueItem>();

  async saveArtifact(input: AnalysisArtifactInput): Promise<AnalysisArtifact> {
    const now = new Date();
    const shouldQueue = input.reviewCandidates.length > 0 || (input.confidence ?? 1) < 0.6;

    const artifact: AnalysisArtifact = {
      ...cloneArtifactInput(input),
      id: randomUUID(),
      createdAt: now,
      updatedAt: now,
      status: shouldQueue ? 'pending_review' : 'ready',
      candidateDecisions: [],
    };

    this.artifacts.set(artifact.id, artifact);
    if (shouldQueue) {
      this.reviewQueue.set(artifact.id, {
        artifactId: artifact.id,
        sourceId: artifact.sourceId,
        queuedAt: now,
        reviewCount: 0,
      });
    }

    return cloneArtifact(artifact);
  }

  async loadArtifact(id: string): Promise<AnalysisArtifact | null> {
    const artifact = this.artifacts.get(id);
    return artifact ? cloneArtifact(artifact) : null;
  }

  async listReviewQueue(): Promise<ArtifactReviewQueueItem[]> {
    return Array.from(this.reviewQueue.values())
      .sort((a, b) => a.queuedAt.getTime() - b.queuedAt.getTime())
      .map(cloneQueueItem);
  }

  async approveCandidate(artifactId: string, decision: ArtifactCandidateDecision): Promise<AnalysisArtifact> {
    return this.reviewCandidate(artifactId, { ...decision, action: decision.action ?? 'approved' });
  }

  async rejectCandidate(artifactId: string, decision: ArtifactCandidateDecision): Promise<AnalysisArtifact> {
    return this.reviewCandidate(artifactId, { ...decision, action: 'rejected' });
  }

  async reviewCandidate(artifactId: string, decision: ArtifactCandidateDecision): Promise<AnalysisArtifact> {
    const artifact = this.artifacts.get(artifactId);
    if (!artifact) throw new Error(`Artifact not found: ${artifactId}`);

    const record: CandidateReviewRecord = {
      ...decision,
      reviewedAt: new Date(),
    };

    const next = cloneArtifact(artifact);
    next.candidateDecisions = [
      ...next.candidateDecisions.filter(item => item.candidateId !== decision.candidateId),
      record,
    ];

    if (decision.editedValue !== undefined) {
      this.applyEditedValue(next, decision.candidateId, decision.editedValue);
    }

    const unresolved = next.reviewCandidates.filter(candidate =>
      !next.candidateDecisions.some(decisionItem => decisionItem.candidateId === candidate.candidateId),
    );

    next.status = unresolved.length === 0 ? 'approved' : 'pending_review';
    next.updatedAt = new Date();

    this.artifacts.set(artifactId, next);

    if (next.status === 'approved') {
      this.reviewQueue.delete(artifactId);
    } else {
      const existingQueue = this.reviewQueue.get(artifactId);
      this.reviewQueue.set(artifactId, {
        artifactId,
        sourceId: next.sourceId,
        queuedAt: existingQueue?.queuedAt ?? new Date(),
        reviewCount: (existingQueue?.reviewCount ?? 0) + 1,
      });
    }

    return cloneArtifact(next);
  }

  async createResearchTasksFromArtifact(
    options: ArtifactToResearchTaskOptions,
  ): Promise<ResearchTask[]> {
    const artifact = this.artifacts.get(options.artifactId);
    if (!artifact) throw new Error(`Artifact not found: ${options.artifactId}`);

    const createdAt = options.createdAt ?? new Date();
    const priority = options.priority ?? 'medium';

    return artifact.recommendedResearchQueries.map((query, index) => ({
      id: randomUUID(),
      gapId: `${artifact.id}:artifact-gap:${index + 1}`,
      gapType: 'frequency_blind_spot',
      title: `调研：${query}`,
      objective: `基于分析产物 ${artifact.id} 继续补齐问题“${query}”。`,
      scope: {
        topic: query,
        boundaries: [`来源分析产物：${artifact.sourceId}`],
        acquisitionMethods: ['web_search', 'document_read'],
      },
      expectedKnowledgeTypes: ['fact', 'methodology', 'experience'],
      strategy: {
        steps: [
          {
            id: `${artifact.id}-research-${index + 1}-search`,
            method: 'web_search',
            query,
            rationale: '先拉齐外部事实与一手资料。',
            limit: 5,
          },
        ],
        searchQueries: [query],
        notes: `由分析产物 ${artifact.id} 自动生成。`,
      },
      completionCriteria: [
        '形成至少 1 条可检索事实知识。',
        '补齐该分析产物标记出的研究问题。',
      ],
      budget: {
        maxDurationMs: 10 * 60 * 1000,
        maxApiCalls: 8,
      },
      priority,
      impactScore: priority === 'high' ? 3 : priority === 'medium' ? 2 : 1,
      urgencyScore: artifact.gapCandidates.length > 0 ? 2 : 1,
      blocking: artifact.reviewCandidates.length > 0,
      createdAt,
    }));
  }

  private applyEditedValue(artifact: AnalysisArtifact, candidateId: string, editedValue: string): void {
    const collections: AnalysisCandidate[][] = [
      artifact.entityCandidates,
      artifact.conceptCandidates,
      artifact.linkCandidates,
      artifact.conflictCandidates,
      artifact.gapCandidates,
    ];

    for (const collection of collections) {
      const candidate = collection.find(item => item.id === candidateId);
      if (candidate) {
        candidate.label = editedValue;
        return;
      }
    }

    const claim = artifact.extractedClaims.find(item => item.id === candidateId);
    if (claim) {
      claim.text = editedValue;
      return;
    }

    const queryIndex = artifact.recommendedResearchQueries.findIndex((_, index) => `research-query-${index}` === candidateId);
    if (queryIndex >= 0) {
      artifact.recommendedResearchQueries[queryIndex] = editedValue;
    }
  }
}

function cloneArtifactInput(input: AnalysisArtifactInput): AnalysisArtifactInput {
  return {
    sourceId: input.sourceId,
    pipelineId: input.pipelineId,
    extractedClaims: input.extractedClaims.map(cloneClaim),
    entityCandidates: input.entityCandidates.map(cloneCandidate),
    conceptCandidates: input.conceptCandidates.map(cloneCandidate),
    linkCandidates: input.linkCandidates.map(cloneCandidate),
    conflictCandidates: input.conflictCandidates.map(cloneCandidate),
    gapCandidates: input.gapCandidates.map(cloneCandidate),
    reviewCandidates: input.reviewCandidates.map(cloneReviewCandidate),
    recommendedResearchQueries: [...input.recommendedResearchQueries],
    confidence: input.confidence,
  };
}

function cloneArtifact(artifact: AnalysisArtifact): AnalysisArtifact {
  return {
    ...cloneArtifactInput(artifact),
    id: artifact.id,
    createdAt: new Date(artifact.createdAt),
    updatedAt: new Date(artifact.updatedAt),
    status: artifact.status,
    candidateDecisions: artifact.candidateDecisions.map(decision => ({
      ...decision,
      reviewedAt: new Date(decision.reviewedAt),
    })),
  };
}

function cloneClaim(claim: AnalysisClaim): AnalysisClaim {
  return {
    id: claim.id,
    text: claim.text,
    confidence: claim.confidence,
    type: claim.type,
  };
}

function cloneCandidate(candidate: AnalysisCandidate): AnalysisCandidate {
  return {
    id: candidate.id,
    label: candidate.label,
    confidence: candidate.confidence,
    payload: candidate.payload ? { ...candidate.payload } : undefined,
  };
}

function cloneReviewCandidate(candidate: ReviewCandidate): ReviewCandidate {
  return {
    id: candidate.id,
    field: candidate.field,
    candidateId: candidate.candidateId,
    reason: candidate.reason,
    confidence: candidate.confidence,
  };
}

function cloneQueueItem(item: ArtifactReviewQueueItem): ArtifactReviewQueueItem {
  return {
    artifactId: item.artifactId,
    sourceId: item.sourceId,
    queuedAt: new Date(item.queuedAt),
    reviewCount: item.reviewCount,
  };
}
