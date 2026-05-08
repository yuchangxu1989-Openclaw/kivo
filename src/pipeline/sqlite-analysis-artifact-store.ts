/**
 * SQLiteAnalysisArtifactStore — SQLite-backed analysis artifact persistence
 *
 * Drop-in replacement for the in-memory AnalysisArtifactStore.
 * Stores artifacts and review queue in SQLite for persistence across restarts.
 */

import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { ResearchTask } from '../research/research-task-types.js';
import type {
  AnalysisArtifact,
  AnalysisArtifactInput,
  AnalysisCandidateAction,
  ArtifactCandidateDecision,
  ArtifactReviewQueueItem,
  ArtifactToResearchTaskOptions,
  CandidateReviewRecord,
} from './analysis-artifact-store.js';

export interface SQLiteAnalysisArtifactStoreOptions {
  db: Database.Database;
}

export class SQLiteAnalysisArtifactStore {
  private readonly db: Database.Database;

  constructor(options: SQLiteAnalysisArtifactStoreOptions) {
    this.db = options.db;
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS analysis_artifacts (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL,
        pipeline_id TEXT,
        data_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'ready',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_artifacts_status ON analysis_artifacts(status);
      CREATE INDEX IF NOT EXISTS idx_artifacts_source ON analysis_artifacts(source_id);

      CREATE TABLE IF NOT EXISTS artifact_review_queue (
        artifact_id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL,
        queued_at TEXT NOT NULL,
        review_count INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY (artifact_id) REFERENCES analysis_artifacts(id) ON DELETE CASCADE
      );
    `);
  }

  async saveArtifact(input: AnalysisArtifactInput): Promise<AnalysisArtifact> {
    const now = new Date();
    const shouldQueue = input.reviewCandidates.length > 0 || (input.confidence ?? 1) < 0.6;

    const artifact: AnalysisArtifact = {
      ...input,
      id: randomUUID(),
      createdAt: now,
      updatedAt: now,
      status: shouldQueue ? 'pending_review' : 'ready',
      candidateDecisions: [],
    };

    const txn = this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO analysis_artifacts (id, source_id, pipeline_id, data_json, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        artifact.id, artifact.sourceId, artifact.pipelineId ?? null,
        JSON.stringify(artifact), artifact.status,
        artifact.createdAt.toISOString(), artifact.updatedAt.toISOString()
      );

      if (shouldQueue) {
        this.db.prepare(`
          INSERT INTO artifact_review_queue (artifact_id, source_id, queued_at, review_count)
          VALUES (?, ?, ?, 0)
        `).run(artifact.id, artifact.sourceId, now.toISOString());
      }
    });
    txn();

    return JSON.parse(JSON.stringify(artifact, dateReplacer), dateReviver);
  }

  async loadArtifact(id: string): Promise<AnalysisArtifact | null> {
    const row = this.db.prepare(
      'SELECT data_json FROM analysis_artifacts WHERE id = ?'
    ).get(id) as { data_json: string } | undefined;

    if (!row) return null;
    return JSON.parse(row.data_json, dateReviver) as AnalysisArtifact;
  }

  async listReviewQueue(): Promise<ArtifactReviewQueueItem[]> {
    const rows = this.db.prepare(
      'SELECT artifact_id, source_id, queued_at, review_count FROM artifact_review_queue ORDER BY queued_at ASC'
    ).all() as Array<{ artifact_id: string; source_id: string; queued_at: string; review_count: number }>;

    return rows.map(r => ({
      artifactId: r.artifact_id,
      sourceId: r.source_id,
      queuedAt: new Date(r.queued_at),
      reviewCount: r.review_count,
    }));
  }

  async approveCandidate(artifactId: string, decision: ArtifactCandidateDecision): Promise<AnalysisArtifact> {
    return this.reviewCandidate(artifactId, { ...decision, action: decision.action ?? 'approved' });
  }

  async rejectCandidate(artifactId: string, decision: ArtifactCandidateDecision): Promise<AnalysisArtifact> {
    return this.reviewCandidate(artifactId, { ...decision, action: 'rejected' });
  }

  async reviewCandidate(artifactId: string, decision: ArtifactCandidateDecision): Promise<AnalysisArtifact> {
    const artifact = await this.loadArtifact(artifactId);
    if (!artifact) throw new Error(`Artifact not found: ${artifactId}`);

    const record: CandidateReviewRecord = {
      ...decision,
      reviewedAt: new Date(),
    };

    artifact.candidateDecisions = [
      ...artifact.candidateDecisions.filter(item => item.candidateId !== decision.candidateId),
      record,
    ];

    if (decision.editedValue !== undefined) {
      this.applyEditedValue(artifact, decision.candidateId, decision.editedValue);
    }

    const unresolved = artifact.reviewCandidates.filter(candidate =>
      !artifact.candidateDecisions.some(d => d.candidateId === candidate.candidateId),
    );

    artifact.status = unresolved.length === 0 ? 'approved' : 'pending_review';
    artifact.updatedAt = new Date();

    const txn = this.db.transaction(() => {
      this.db.prepare(`
        UPDATE analysis_artifacts SET data_json = ?, status = ?, updated_at = ? WHERE id = ?
      `).run(JSON.stringify(artifact), artifact.status, artifact.updatedAt.toISOString(), artifactId);

      if (artifact.status === 'approved') {
        this.db.prepare('DELETE FROM artifact_review_queue WHERE artifact_id = ?').run(artifactId);
      } else {
        const existing = this.db.prepare(
          'SELECT review_count FROM artifact_review_queue WHERE artifact_id = ?'
        ).get(artifactId) as { review_count: number } | undefined;

        if (existing) {
          this.db.prepare(
            'UPDATE artifact_review_queue SET review_count = ? WHERE artifact_id = ?'
          ).run(existing.review_count + 1, artifactId);
        } else {
          this.db.prepare(`
            INSERT INTO artifact_review_queue (artifact_id, source_id, queued_at, review_count)
            VALUES (?, ?, ?, 1)
          `).run(artifactId, artifact.sourceId, new Date().toISOString());
        }
      }
    });
    txn();

    return JSON.parse(JSON.stringify(artifact, dateReplacer), dateReviver);
  }

  async createResearchTasksFromArtifact(
    options: ArtifactToResearchTaskOptions,
  ): Promise<ResearchTask[]> {
    const artifact = await this.loadArtifact(options.artifactId);
    if (!artifact) throw new Error(`Artifact not found: ${options.artifactId}`);

    const createdAt = options.createdAt ?? new Date();
    const priority = options.priority ?? 'medium';

    return artifact.recommendedResearchQueries.map((query, index) => ({
      id: randomUUID(),
      gapId: `${artifact.id}:artifact-gap:${index + 1}`,
      gapType: 'frequency_blind_spot',
      title: `调研：${query}`,
      objective: `基于分析产物 ${artifact.id} 继续补齐问题"${query}"。`,
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
    const collections = [
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

    const queryIndex = artifact.recommendedResearchQueries.findIndex(
      (_, index) => `research-query-${index}` === candidateId
    );
    if (queryIndex >= 0) {
      artifact.recommendedResearchQueries[queryIndex] = editedValue;
    }
  }
}

// Date serialization helpers for JSON round-trip
function dateReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  return value;
}

function dateReviver(key: string, value: unknown): unknown {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value)) {
    const dateFields = ['createdAt', 'updatedAt', 'queuedAt', 'reviewedAt', 'timestamp'];
    if (dateFields.includes(key)) return new Date(value);
  }
  return value;
}
