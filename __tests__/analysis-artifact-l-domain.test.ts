/**
 * Tests for Domain L: Analysis Artifacts
 * FR-L01, FR-L02
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  AnalysisArtifactStore,
  type AnalysisArtifactInput,
  type AnalysisClaim,
  type AnalysisCandidate,
  type ReviewCandidate,
} from '../src/pipeline/analysis-artifact-store.js';

function makeClaim(overrides: Partial<AnalysisClaim> = {}): AnalysisClaim {
  return {
    id: `claim-${Math.random().toString(36).slice(2, 8)}`,
    text: 'TypeScript is a typed superset of JavaScript.',
    confidence: 0.9,
    type: 'fact',
    ...overrides,
  };
}

function makeCandidate(overrides: Partial<AnalysisCandidate> = {}): AnalysisCandidate {
  return {
    id: `cand-${Math.random().toString(36).slice(2, 8)}`,
    label: 'TypeScript',
    confidence: 0.85,
    ...overrides,
  };
}

function makeReviewCandidate(overrides: Partial<ReviewCandidate> = {}): ReviewCandidate {
  return {
    id: `rev-${Math.random().toString(36).slice(2, 8)}`,
    field: 'extractedClaims',
    candidateId: 'claim-1',
    reason: 'Low confidence claim needs verification',
    confidence: 0.4,
    ...overrides,
  };
}

function makeArtifactInput(overrides: Partial<AnalysisArtifactInput> = {}): AnalysisArtifactInput {
  return {
    sourceId: 'doc-001',
    pipelineId: 'pipeline-001',
    extractedClaims: [makeClaim()],
    entityCandidates: [makeCandidate({ label: 'TypeScript' })],
    conceptCandidates: [makeCandidate({ label: 'Type Safety' })],
    linkCandidates: [makeCandidate({ label: 'TypeScript → JavaScript' })],
    conflictCandidates: [],
    gapCandidates: [makeCandidate({ label: 'Missing: Runtime type checking' })],
    reviewCandidates: [],
    recommendedResearchQueries: ['How does TypeScript handle runtime types?'],
    confidence: 0.8,
    ...overrides,
  };
}

// ── FR-L01: Analysis Artifact Generation ──

describe('FR-L01: Analysis Artifact Generation', () => {
  let store: AnalysisArtifactStore;

  beforeEach(() => {
    store = new AnalysisArtifactStore();
  });

  it('AC1: artifact contains all required structured fields', async () => {
    const input = makeArtifactInput();
    const artifact = await store.saveArtifact(input);

    expect(artifact.id).toBeTruthy();
    expect(artifact.sourceId).toBe('doc-001');
    expect(artifact.extractedClaims).toHaveLength(1);
    expect(artifact.entityCandidates).toHaveLength(1);
    expect(artifact.conceptCandidates).toHaveLength(1);
    expect(artifact.linkCandidates).toHaveLength(1);
    expect(artifact.conflictCandidates).toHaveLength(0);
    expect(artifact.gapCandidates).toHaveLength(1);
    expect(artifact.reviewCandidates).toHaveLength(0);
    expect(artifact.recommendedResearchQueries).toHaveLength(1);
  });

  it('AC2: artifact linked to source via sourceId', async () => {
    const artifact = await store.saveArtifact(makeArtifactInput({ sourceId: 'conversation-42' }));
    expect(artifact.sourceId).toBe('conversation-42');

    const loaded = await store.loadArtifact(artifact.id);
    expect(loaded!.sourceId).toBe('conversation-42');
  });

  it('AC3: artifact persisted and retrievable', async () => {
    const artifact = await store.saveArtifact(makeArtifactInput());
    const loaded = await store.loadArtifact(artifact.id);

    expect(loaded).toBeTruthy();
    expect(loaded!.id).toBe(artifact.id);
    expect(loaded!.extractedClaims).toHaveLength(1);
    expect(loaded!.createdAt).toBeInstanceOf(Date);
  });

  it('AC3: artifact not lost after knowledge entry generation', async () => {
    // Save artifact, then simulate knowledge generation (no deletion)
    const artifact = await store.saveArtifact(makeArtifactInput());

    // Artifact should still be retrievable
    const loaded = await store.loadArtifact(artifact.id);
    expect(loaded).toBeTruthy();
    expect(loaded!.status).toBe('ready');
  });

  it('returns null for non-existent artifact', async () => {
    const loaded = await store.loadArtifact('non-existent');
    expect(loaded).toBeNull();
  });
});

// ── FR-L02: Analysis Artifact Review & Consumption ──

describe('FR-L02: Analysis Artifact Review & Consumption', () => {
  let store: AnalysisArtifactStore;

  beforeEach(() => {
    store = new AnalysisArtifactStore();
  });

  it('AC1: review queue lists pending artifacts', async () => {
    const reviewCandidate = makeReviewCandidate({ candidateId: 'claim-1' });
    await store.saveArtifact(makeArtifactInput({
      reviewCandidates: [reviewCandidate],
    }));
    await store.saveArtifact(makeArtifactInput({
      sourceId: 'doc-002',
      reviewCandidates: [makeReviewCandidate({ candidateId: 'claim-2' })],
    }));

    const queue = await store.listReviewQueue();
    expect(queue).toHaveLength(2);
    expect(queue[0].artifactId).toBeTruthy();
    expect(queue[0].sourceId).toBeTruthy();
  });

  it('AC2: approve candidate', async () => {
    const reviewCandidate = makeReviewCandidate({ candidateId: 'claim-1' });
    const artifact = await store.saveArtifact(makeArtifactInput({
      reviewCandidates: [reviewCandidate],
    }));

    expect(artifact.status).toBe('pending_review');

    const updated = await store.approveCandidate(artifact.id, {
      candidateId: 'claim-1',
      action: 'approved',
    });

    expect(updated.status).toBe('approved');
    expect(updated.candidateDecisions).toHaveLength(1);
    expect(updated.candidateDecisions[0].action).toBe('approved');
  });

  it('AC2: reject candidate', async () => {
    const reviewCandidate = makeReviewCandidate({ candidateId: 'claim-1' });
    const artifact = await store.saveArtifact(makeArtifactInput({
      reviewCandidates: [reviewCandidate],
    }));

    const updated = await store.rejectCandidate(artifact.id, {
      candidateId: 'claim-1',
      action: 'rejected',
      note: 'Inaccurate claim',
    });

    expect(updated.status).toBe('approved'); // all review candidates resolved
    expect(updated.candidateDecisions[0].action).toBe('rejected');
  });

  it('AC2: edit candidate value', async () => {
    const reviewCandidate = makeReviewCandidate({ candidateId: 'claim-1' });
    const artifact = await store.saveArtifact(makeArtifactInput({
      reviewCandidates: [reviewCandidate],
    }));

    const updated = await store.reviewCandidate(artifact.id, {
      candidateId: 'claim-1',
      action: 'edited',
      editedValue: 'Corrected claim text',
    });

    expect(updated.candidateDecisions[0].action).toBe('edited');
    expect(updated.candidateDecisions[0].editedValue).toBe('Corrected claim text');
  });

  it('AC2: multiple review candidates — partial review keeps pending', async () => {
    const artifact = await store.saveArtifact(makeArtifactInput({
      reviewCandidates: [
        makeReviewCandidate({ candidateId: 'claim-1' }),
        makeReviewCandidate({ candidateId: 'claim-2' }),
      ],
    }));

    // Approve only first
    const partial = await store.approveCandidate(artifact.id, {
      candidateId: 'claim-1',
      action: 'approved',
    });
    expect(partial.status).toBe('pending_review');

    // Approve second
    const complete = await store.approveCandidate(artifact.id, {
      candidateId: 'claim-2',
      action: 'approved',
    });
    expect(complete.status).toBe('approved');
  });

  it('AC3: high confidence artifact auto-ready, low confidence queued', async () => {
    const highConf = await store.saveArtifact(makeArtifactInput({
      confidence: 0.9,
      reviewCandidates: [],
    }));
    expect(highConf.status).toBe('ready');

    const lowConf = await store.saveArtifact(makeArtifactInput({
      confidence: 0.3,
      reviewCandidates: [],
    }));
    expect(lowConf.status).toBe('pending_review');

    const queue = await store.listReviewQueue();
    expect(queue.some(q => q.artifactId === lowConf.id)).toBe(true);
    expect(queue.some(q => q.artifactId === highConf.id)).toBe(false);
  });

  it('AC3: review candidates force queue regardless of confidence', async () => {
    const artifact = await store.saveArtifact(makeArtifactInput({
      confidence: 0.99,
      reviewCandidates: [makeReviewCandidate({ candidateId: 'claim-1' })],
    }));
    expect(artifact.status).toBe('pending_review');
  });

  it('AC4: create research tasks from gap candidates', async () => {
    const artifact = await store.saveArtifact(makeArtifactInput({
      recommendedResearchQueries: [
        'How does TypeScript handle runtime types?',
        'What are the alternatives to TypeScript?',
      ],
    }));

    const tasks = await store.createResearchTasksFromArtifact({
      artifactId: artifact.id,
      priority: 'high',
    });

    expect(tasks).toHaveLength(2);
    expect(tasks[0].title).toContain('调研');
    expect(tasks[0].priority).toBe('high');
    expect(tasks[0].objective).toContain(artifact.id);
    expect(tasks[0].scope.topic).toBe('How does TypeScript handle runtime types?');
    expect(tasks[1].scope.topic).toBe('What are the alternatives to TypeScript?');
  });

  it('AC4: research task creation fails for non-existent artifact', async () => {
    await expect(
      store.createResearchTasksFromArtifact({ artifactId: 'non-existent' }),
    ).rejects.toThrow(/not found/);
  });

  it('approved artifact removed from review queue', async () => {
    const artifact = await store.saveArtifact(makeArtifactInput({
      reviewCandidates: [makeReviewCandidate({ candidateId: 'claim-1' })],
    }));

    let queue = await store.listReviewQueue();
    expect(queue).toHaveLength(1);

    await store.approveCandidate(artifact.id, {
      candidateId: 'claim-1',
      action: 'approved',
    });

    queue = await store.listReviewQueue();
    expect(queue).toHaveLength(0);
  });
});
