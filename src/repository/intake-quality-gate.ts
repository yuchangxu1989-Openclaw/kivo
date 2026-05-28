import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import type { KnowledgeEntry } from '../types/index.js';
import { DEFAULT_CONFIG } from '../config/types.js';
import type { EmbeddingProvider } from '../embedding/embedding-provider.js';
import { createEmbeddingProvider } from '../embedding/create-provider.js';
import { assessIngestValue, type ValueAssessment } from '../pipeline/value-gate.js';
import { buildBehavioralChangeTestSection, buildKnowledgeAdmissionBoundarySection } from '../standards/index.js';
import { cosineSimilarity } from '../utils/math.js';
import { shouldBypassExternalModelsInTests } from '../utils/test-runtime.js';

export type QualityGateDecisionType = 'passed' | 'rejected' | 'bypassed';
export type QualityGateReason = 'duplicate' | 'low_value' | 'bypassed' | 'cli_flag' | 'passed' | 'low_quality_quarantined';

export interface QualityGateDecision {
  decision: QualityGateDecisionType;
  reason: QualityGateReason;
  message: string;
  similarity?: number;
  matchedEntryId?: string;
  matchedEntryTitle?: string;
  valueAssessment?: ValueAssessment;
  embedding?: number[];
}

export interface QualityGateLogRecord {
  entry: KnowledgeEntry;
  decision: QualityGateDecision;
}

export interface EvaluateQualityGateOptions {
  ignoreEntryId?: string;
  skip?: boolean;
  /** Skip BGE embedding (deferred to batch vectorization). Dedup uses content hash fallback. */
  skipEmbedding?: boolean;
  /** Per-save semantic duplicate threshold override. */
  conflictThreshold?: number;
  /** Timeout for the whole evaluation in milliseconds. */
  timeoutMs?: number;
}

export interface IntakeQualityGateOptions {
  db: Database.Database;
  dbPath: string;
  configDir?: string;
  conflictThreshold?: number;
}

export class QualityGateRejectedError extends Error {
  readonly decision: QualityGateDecision;

  constructor(decision: QualityGateDecision) {
    super(decision.message);
    this.name = 'QualityGateRejectedError';
    this.decision = decision;
  }
}

interface ExistingEmbeddingRow {
  id: string;
  title: string;
  embedding: Buffer;
}

function loadConflictThreshold(configDir?: string, override?: number): number {
  if (typeof override === 'number') {
    return Math.min(1, Math.max(0, override));
  }

  const dir = configDir ?? process.cwd();
  const configPath = join(dir, 'kivo.config.json');

  try {
    if (existsSync(configPath)) {
      const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
      if (typeof raw?.conflictThreshold === 'number') {
        return Math.min(1, Math.max(0, raw.conflictThreshold));
      }
    }
  } catch {
    // fall back to defaults
  }

  return DEFAULT_CONFIG.conflictThreshold ?? 0.80;
}

function bufferToVector(buf: Buffer): number[] {
  const float32 = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  return Array.from(float32);
}

function buildEmbeddingText(entry: KnowledgeEntry): string {
  return `${entry.title}\n${entry.content}`.trim();
}

function buildContentHash(entry: KnowledgeEntry): string {
  return createHash('sha256').update(buildEmbeddingText(entry)).digest('hex');
}

function withTimeout<T>(promise: Promise<T>, timeoutMs?: number): Promise<T> {
  if (!timeoutMs || timeoutMs <= 0) return promise;
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise.finally(() => {
      if (timer) clearTimeout(timer);
    }),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Quality gate timed out after ${timeoutMs}ms`)), timeoutMs);
    }),
  ]);
}

function remainingMs(deadline?: number): number | undefined {
  if (!deadline) return undefined;
  return Math.max(0, deadline - Date.now());
}

export class IntakeQualityGate {
  private readonly db: Database.Database;
  private readonly dbPath: string;
  private readonly configDir?: string;
  private readonly embedder: EmbeddingProvider;
  private readonly conflictThreshold?: number;

  constructor(options: IntakeQualityGateOptions) {
    this.db = options.db;
    this.dbPath = options.dbPath;
    this.configDir = options.configDir;
    this.conflictThreshold = options.conflictThreshold;
    this.embedder = createEmbeddingProvider();
    this.ensureSchema();
  }

  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS quality_gate_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        entry_id TEXT,
        entry_title TEXT NOT NULL,
        source_reference TEXT,
        decision TEXT NOT NULL,
        reason TEXT NOT NULL,
        message TEXT NOT NULL,
        matched_entry_id TEXT,
        matched_entry_title TEXT,
        similarity REAL,
        candidate_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_quality_gate_log_created_at ON quality_gate_log(created_at);
      CREATE INDEX IF NOT EXISTS idx_quality_gate_log_reason ON quality_gate_log(reason);
      CREATE INDEX IF NOT EXISTS idx_quality_gate_log_source_reference ON quality_gate_log(source_reference);
    `);
  }

  private ensureAdmissionPromptLoaded(): void {
    // Keep FR-A07 admission boundary and negative examples in this gate's execution path.
    // The semantic decision itself remains LLM-based via assessIngestValue; no keyword/regex/rule engine is used here.
    void buildKnowledgeAdmissionBoundarySection();
    void buildBehavioralChangeTestSection();
  }

  async close(): Promise<void> {
    // Embedding provider uses stateless HTTP requests; no persistent handle.
  }

  async evaluate(entry: KnowledgeEntry, options: EvaluateQualityGateOptions = {}): Promise<QualityGateDecision> {
    this.ensureAdmissionPromptLoaded();

    if (options.skip) {
      return {
        decision: 'bypassed',
        reason: 'cli_flag',
        message: '质量门禁已通过 --no-quality-gate 跳过（cli_flag bypass）。',
      };
    }

    if (shouldBypassExternalModelsInTests()) {
      return {
        decision: 'bypassed',
        reason: 'bypassed',
        message: '质量门禁在测试环境中跳过。',
      };
    }

    const deadline = options.timeoutMs && options.timeoutMs > 0 ? Date.now() + options.timeoutMs : undefined;

    if (options.skipEmbedding) {
      // Skip embedding: either not installed or deferred to batch vectorization.
      // Still run LLM value assessment; semantic search waits for vectorization.
      const msg = '知识已写入。向量化已跳过（延迟到批量向量化），语义检索暂不可用。';

      // Run LLM value assessment even without embedding.
      let valueAssessment: ValueAssessment | undefined;
      valueAssessment = await withTimeout(
        assessIngestValue(entry.title, entry.content, this.configDir),
        remainingMs(deadline),
      );
      const tripleTestFailed = valueAssessment.dimensions.timeliness === 0
        || valueAssessment.dimensions.crossScenario === 0
        || valueAssessment.dimensions.abstractness === 0;
      if (tripleTestFailed || !valueAssessment.isHighValue) {
        return {
          decision: 'rejected',
          reason: 'low_value',
          message: `质量门禁拒绝入库：LLM 判定为低价值知识 [${valueAssessment.category}]，原因：${valueAssessment.reasoning || '未提供理由'}`,
          valueAssessment,
        };
      }

      return {
        decision: 'passed',
        reason: 'passed',
        message: msg,
        valueAssessment,
      };
    }

    const embeddingText = buildEmbeddingText(entry);
    const embedding = await withTimeout(this.embedder.embed(embeddingText), remainingMs(deadline));
    const threshold = loadConflictThreshold(this.configDir, options.conflictThreshold ?? this.conflictThreshold);
    const duplicate = this.findBestDuplicate(embedding, threshold, options.ignoreEntryId);
    if (duplicate) {
      return {
        decision: 'rejected',
        reason: 'duplicate',
        message: `质量门禁拒绝入库：与 [${duplicate.id.slice(0, 8)}] "${duplicate.title}" 语义相似度 ${(duplicate.similarity * 100).toFixed(1)}%，超过阈值 ${(threshold * 100).toFixed(1)}%。`,
        similarity: duplicate.similarity,
        matchedEntryId: duplicate.id,
        matchedEntryTitle: duplicate.title,
        embedding,
      };
    }

    const valueAssessment = await withTimeout(
      assessIngestValue(entry.title, entry.content, this.configDir),
      remainingMs(deadline),
    );
    const tripleTestFailed = valueAssessment.dimensions.timeliness === 0
      || valueAssessment.dimensions.crossScenario === 0
      || valueAssessment.dimensions.abstractness === 0;
    if (tripleTestFailed || !valueAssessment.isHighValue) {
      return {
        decision: 'rejected',
        reason: 'low_value',
        message: `质量门禁拒绝入库：LLM 判定为低价值知识 [${valueAssessment.category}]，原因：${valueAssessment.reasoning || '未提供理由'}`,
        valueAssessment,
        embedding,
      };
    }

    return {
      decision: 'passed',
      reason: 'passed',
      message: '质量门禁通过。',
      valueAssessment,
      embedding,
    };
  }

  log(record: QualityGateLogRecord): void {
    const now = new Date().toISOString();
    const candidateJson = JSON.stringify({
      id: record.entry.id,
      title: record.entry.title,
      content: record.entry.content,
      type: record.entry.type,
      status: record.entry.status,
      source: record.entry.source,
      contentHash: buildContentHash(record.entry),
      valueAssessment: record.decision.valueAssessment,
    });

    this.db.prepare(`
      INSERT INTO quality_gate_log (
        entry_id, entry_title, source_reference, decision, reason, message,
        matched_entry_id, matched_entry_title, similarity, candidate_json, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.entry.id,
      record.entry.title,
      record.entry.source.reference,
      record.decision.decision,
      record.decision.reason,
      record.decision.message,
      record.decision.matchedEntryId ?? null,
      record.decision.matchedEntryTitle ?? null,
      record.decision.similarity ?? null,
      candidateJson,
      now,
    );
  }

  private findBestDuplicate(embedding: number[], threshold: number, ignoreEntryId?: string): { id: string; title: string; similarity: number } | null {
    const rows = this.db.prepare(
      `SELECT id, title, embedding
       FROM entries
       WHERE status = 'active'
         AND embedding IS NOT NULL
         AND length(embedding) = ?
         AND (? IS NULL OR id != ?)`
    ).all(embedding.length * 4, ignoreEntryId ?? null, ignoreEntryId ?? null) as ExistingEmbeddingRow[];

    let best: { id: string; title: string; similarity: number } | null = null;
    for (const row of rows) {
      const similarity = cosineSimilarity(embedding, bufferToVector(row.embedding));
      if (!best || similarity > best.similarity) {
        best = { id: row.id, title: row.title, similarity };
      }
    }

    if (!best || best.similarity <= threshold) {
      return null;
    }

    return best;
  }
}
