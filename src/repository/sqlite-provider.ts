/**
 * SQLiteProvider — 默认存储后端
 * 使用 better-sqlite3，FTS5 全文索引，事务保证原子性。
 */

import Database from 'better-sqlite3';
import type { KnowledgeEntry, EntryStatus, KnowledgeType, KnowledgeSource, KnowledgeNature, KnowledgeFunction, EntryType } from '../types/index.js';
import { shortenKnowledgeTitle } from '../extraction/extraction-utils.js';
import { shouldBypassExternalModelsInTests } from '../utils/test-runtime.js';
import type { StorageProvider, SemanticQuery, SearchResult, SaveOptions, GraphExpansionOptions, GraphExpansionResult } from './storage-provider.js';
import { IntakeQualityGate, type QualityGateDecision } from './intake-quality-gate.js';
import { ensureIntentSchema } from './intent-repository.js';

/** Cosine similarity between two vectors */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/** Clamp an edge weight to [0, 1], treating non-finite values as 0. */
function clampWeight(value: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/** Map an FTS5 bm25 rank (<= 0, more negative = stronger) to a (0, 1) score. */
function ftsRankToScore(rank: number): number {
  if (!Number.isFinite(rank)) return 0.5;
  const s = 1 / (1 + Math.exp(rank));
  return Math.max(0, Math.min(1, s));
}

export interface SQLiteProviderOptions {
  dbPath: string;
  configDir?: string;
}

export class SQLiteProvider implements StorageProvider {
  private db: Database.Database;
  private readonly qualityGate: IntakeQualityGate;

  constructor(options: SQLiteProviderOptions) {
    this.db = new Database(options.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.initSchema();
    this.qualityGate = new IntakeQualityGate({
      db: this.db,
      dbPath: options.dbPath,
      configDir: options.configDir,
    });
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS entries (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        source_json TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 0.5,
        status TEXT NOT NULL DEFAULT 'active',
        tags_json TEXT NOT NULL DEFAULT '[]',
        domain TEXT,
        version INTEGER NOT NULL DEFAULT 1,
        supersedes TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_entries_type ON entries(type);
      CREATE INDEX IF NOT EXISTS idx_entries_status ON entries(status);
      CREATE INDEX IF NOT EXISTS idx_entries_supersedes ON entries(supersedes);
    `);

    // Migration: add columns if missing
    const columns = this.db.prepare('PRAGMA table_info(entries)').all() as Array<{ name: string }>;
    const colNames = new Set(columns.map(c => c.name));
    if (!colNames.has('similar_sentences')) {
      this.db.exec(`ALTER TABLE entries ADD COLUMN similar_sentences TEXT DEFAULT '[]'`);
    }
    // FR-B05: multi-dimensional knowledge tags
    if (!colNames.has('nature')) {
      this.db.exec(`ALTER TABLE entries ADD COLUMN nature TEXT`);
    }
    if (!colNames.has('function_tag')) {
      this.db.exec(`ALTER TABLE entries ADD COLUMN function_tag TEXT`);
    }
    if (!colNames.has('knowledge_domain')) {
      this.db.exec(`ALTER TABLE entries ADD COLUMN knowledge_domain TEXT`);
    }
    if (!colNames.has('metadata_json')) {
      this.db.exec(`ALTER TABLE entries ADD COLUMN metadata_json TEXT`);
    }
    if (!colNames.has('embedding')) {
      this.db.exec(`ALTER TABLE entries ADD COLUMN embedding BLOB`);
    }
    // FR-B03 AC7 / FR-P02-5: subject-material association columns
    if (!colNames.has('subject_id')) {
      this.db.exec(`ALTER TABLE entries ADD COLUMN subject_id TEXT`);
    }
    if (!colNames.has('entry_type')) {
      this.db.exec(`ALTER TABLE entries ADD COLUMN entry_type TEXT`);
    }

    ensureIntentSchema(this.db);

    // Migrate: if entries_fts exists but uses old tokenizer (not trigram), drop and recreate
    const ftsExists = this.db.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='entries_fts'"
    ).get() as { sql: string } | undefined;
    if (ftsExists && !ftsExists.sql.includes('trigram')) {
      this.db.exec(`
        DROP TRIGGER IF EXISTS entries_ai;
        DROP TRIGGER IF EXISTS entries_ad;
        DROP TRIGGER IF EXISTS entries_au;
        DROP TABLE IF EXISTS entries_fts;
      `);
    }

    this.db.exec(`

      CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
        title, content, summary,
        content='entries',
        content_rowid='rowid',
        tokenize='trigram'
      );

      CREATE TRIGGER IF NOT EXISTS entries_ai AFTER INSERT ON entries BEGIN
        INSERT INTO entries_fts(rowid, title, content, summary)
        VALUES (new.rowid, new.title, new.content, new.summary);
      END;

      CREATE TRIGGER IF NOT EXISTS entries_ad AFTER DELETE ON entries BEGIN
        INSERT INTO entries_fts(entries_fts, rowid, title, content, summary)
        VALUES ('delete', old.rowid, old.title, old.content, old.summary);
      END;

      CREATE TRIGGER IF NOT EXISTS entries_au AFTER UPDATE ON entries BEGIN
        INSERT INTO entries_fts(entries_fts, rowid, title, content, summary)
        VALUES ('delete', old.rowid, old.title, old.content, old.summary);
        INSERT INTO entries_fts(rowid, title, content, summary)
        VALUES (new.rowid, new.title, new.content, new.summary);
      END;
    `);

    // Rebuild FTS index after migration (idempotent — safe to run on fresh DB too)
    if (ftsExists && !ftsExists.sql.includes('trigram')) {
      this.db.exec(`INSERT INTO entries_fts(entries_fts) VALUES('rebuild')`);
    }
  }

  /**
   * Semantic dedup: BGE vector similarity.
   * Computes embedding for new entry, searches existing entries by cosine similarity.
   * Returns the id of the duplicate entry if similarity > 0.9.
   */
  private async checkSemanticDuplicate(entry: KnowledgeEntry): Promise<{ duplicateId: string; existingConfidence: number } | null> {
    try {
      const { BgeEmbedder } = await import('../extraction/bge-embedder.js');
      if (!BgeEmbedder.isAvailable()) {
        // BGE not available — skip dedup, allow insert
        return null;
      }

      const embedder = new BgeEmbedder();
      const text = `${entry.title}\n${entry.content}`;
      const embedding = await embedder.embed(text);

      if (!embedding || embedding.length === 0) {
        return null;
      }

      // Get all entries with embeddings
      const rows = this.db.prepare(
        `SELECT id, title, content, confidence, embedding FROM entries WHERE status = 'active' AND type != 'intent' AND embedding IS NOT NULL`
      ).all() as Array<{ id: string; title: string; content: string; confidence: number; embedding: string }>;

      if (rows.length === 0) {
        return null;
      }

      // Find most similar entry by cosine similarity
      let bestId = '';
      let bestSim = 0;
      let bestConfidence = 0;

      for (const row of rows) {
        try {
          const existingEmb = JSON.parse(row.embedding) as number[];
          const sim = cosineSimilarity(embedding, existingEmb);
          if (sim > bestSim) {
            bestSim = sim;
            bestId = row.id;
            bestConfidence = row.confidence;
          }
        } catch {
          // Skip entries with invalid embeddings
          continue;
        }
      }

      if (bestSim >= 0.9) {
        return { duplicateId: bestId, existingConfidence: bestConfidence };
      }

      return null;
    } catch {
      // Any error — fallback to allow insert
      return null;
    }
  }

  async save(entry: KnowledgeEntry, options?: SaveOptions): Promise<boolean> {
    const bypassInTests = shouldBypassExternalModelsInTests();

    // FR-N05: Hard confidence gate — reject entries below 0.7 unless the caller
    // explicitly bypasses all admission gates for migration/debug use.
    const CONFIDENCE_THRESHOLD = 0.7;
    if (!options?.skipQualityGate && !bypassInTests && entry.confidence < CONFIDENCE_THRESHOLD) {
      console.warn(
        `[KIVO] Rejected entry "${entry.title}" — confidence ${entry.confidence} below threshold ${CONFIDENCE_THRESHOLD}`
      );
      return false;
    }

    const isCreate = !this.db.prepare('SELECT 1 FROM entries WHERE id = ?').get(entry.id);

    // Semantic dedup check — only for new entries, skip if opted out or in tests
    if (isCreate && !options?.skipDedup && !bypassInTests) {
      const dupResult = await this.checkSemanticDuplicate(entry);
      if (dupResult) {
        // Accumulate similar expressions for better recall
        const existingRow = this.db.prepare('SELECT similar_sentences FROM entries WHERE id = ?').get(dupResult.duplicateId) as { similar_sentences?: string } | undefined;
        const existing: string[] = JSON.parse(existingRow?.similar_sentences || '[]');
        const newExpression = `${entry.title}: ${entry.content}`.slice(0, 200);
        if (!existing.includes(newExpression)) {
          existing.push(newExpression);
          // Keep max 10 similar expressions
          while (existing.length > 10) existing.shift();
          const now = new Date().toISOString();
          this.db.prepare(`
            UPDATE entries SET similar_sentences = ?, updated_at = ? WHERE id = ?
          `).run(JSON.stringify(existing), now, dupResult.duplicateId);
        }

        if (entry.confidence > dupResult.existingConfidence) {
          // New entry has higher confidence — update existing entry's content/confidence
          const now = new Date().toISOString();
          this.db.prepare(`
            UPDATE entries SET content = ?, confidence = ?, updated_at = ? WHERE id = ?
          `).run(entry.content, entry.confidence, now, dupResult.duplicateId);
          console.log(
            `[KIVO] Dedup: updated existing entry "${dupResult.duplicateId}" with higher-confidence content from "${entry.title}"`
          );
        } else {
          console.log(
            `[KIVO] Dedup: skipped "${entry.title}" — semantically duplicate of existing entry "${dupResult.duplicateId}"`
          );
        }
        return false;
      }
    }
    let gateDecision: QualityGateDecision | null = null;

    if (isCreate) {
      try {
        gateDecision = await this.qualityGate.evaluate(entry, {
          skip: options?.skipQualityGate || bypassInTests,
          skipEmbedding: options?.skipEmbedding,
          conflictThreshold: options?.conflictThreshold,
          timeoutMs: options?.qualityGateTimeoutMs,
        });
      } catch (err) {
        if (!options?.allowWriteOnDedupError) throw err;
        console.warn(
          `[KIVO] Quality gate BGE/dedup failed for "${entry.title}" — retrying without embedding: ${err instanceof Error ? err.message : String(err)}`
        );
        gateDecision = await this.qualityGate.evaluate(entry, {
          skip: options?.skipQualityGate || bypassInTests,
          skipEmbedding: true,
          timeoutMs: options?.qualityGateTimeoutMs,
        });
      }
      this.qualityGate.log({ entry, decision: gateDecision });
      if (gateDecision.decision === 'rejected') {
        return false;
      }
      if (gateDecision.embedding) {
        entry.metadata = {
          ...entry.metadata,
          embedding: {
            ...(entry.metadata?.embedding ?? {}),
            status: 'ready',
            dimensions: gateDecision.embedding.length,
            updatedAt: new Date(),
          },
        };
      }
      if (gateDecision.valueAssessment) {
        entry.metadata = {
          ...entry.metadata,
          domainData: {
            ...(entry.metadata?.domainData ?? {}),
            valueAssessment: {
              isHighValue: gateDecision.valueAssessment.isHighValue,
              category: gateDecision.valueAssessment.category,
              confidence: gateDecision.valueAssessment.confidence,
              reasoning: gateDecision.valueAssessment.reasoning,
              dimensions: gateDecision.valueAssessment.dimensions,
              assessedAt: new Date().toISOString(),
            },
          },
        };
      }
    }

    const now = new Date().toISOString();
    const normalizedTitle = shortenKnowledgeTitle(entry.title, entry.content);

    // Soft governance gate: source_anchor should trace every entry back to its origin.
    // Legacy entries predate this field, so a missing anchor warns but does not block.
    const sourceAnchor = entry.metadata?.source_anchor;
    if (typeof sourceAnchor !== 'string' || sourceAnchor.trim() === '') {
      console.warn(
        `[KIVO] Entry "${entry.title}" (${entry.id}) missing source_anchor — persisting without provenance anchor`
      );
    }

    const sourceJson = JSON.stringify(entry.source);
    const tagsJson = JSON.stringify(entry.tags);
    const similarSentencesJson = JSON.stringify(entry.similarSentences ?? []);
    const nature = entry.nature ?? null;
    const functionTag = entry.functionTag ?? null;
    const knowledgeDomain = entry.knowledgeDomain ?? null;
    const subjectId = entry.subjectId ?? entry.source?.subjectId ?? null;
    const entryType = entry.entryType ?? null;
    const metadataJson = entry.metadata || entry.sourceRange
      ? JSON.stringify({ ...(entry.metadata ?? {}), ...(entry.sourceRange ? { sourceRange: entry.sourceRange } : {}) })
      : null;
    const embeddingBlob = gateDecision?.embedding ? Buffer.from(new Float32Array(gateDecision.embedding).buffer) : null;

    const txn = this.db.transaction(() => {
      const existing = this.db.prepare('SELECT id, version FROM entries WHERE id = ?').get(entry.id) as { id: string; version: number } | undefined;

      if (existing) {
        this.db.prepare(`
          UPDATE entries SET type = ?, title = ?, content = ?, summary = ?, source_json = ?,
            confidence = ?, status = ?, tags_json = ?, domain = ?, version = ?,
            supersedes = ?, similar_sentences = ?, nature = ?, function_tag = ?, knowledge_domain = ?, metadata_json = ?, subject_id = ?, entry_type = ?, updated_at = ?
          WHERE id = ?
        `).run(
          entry.type, normalizedTitle, entry.content, entry.summary, sourceJson,
          entry.confidence, entry.status, tagsJson, entry.domain ?? null,
          existing.version + 1, entry.supersedes ?? null, similarSentencesJson,
          nature, functionTag, knowledgeDomain, metadataJson, subjectId, entryType, now, entry.id
        );
      } else {
        this.db.prepare(`
          INSERT INTO entries (id, type, title, content, summary, source_json, confidence, status, tags_json, domain, version, supersedes, similar_sentences, nature, function_tag, knowledge_domain, metadata_json, embedding, subject_id, entry_type, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          entry.id, entry.type, normalizedTitle, entry.content, entry.summary, sourceJson,
          entry.confidence, entry.status, tagsJson, entry.domain ?? null,
          entry.version ?? 1, entry.supersedes ?? null, similarSentencesJson,
          nature, functionTag, knowledgeDomain, metadataJson, embeddingBlob, subjectId, entryType,
          entry.createdAt.toISOString(), entry.updatedAt.toISOString()
        );
      }
    });
    txn();
    return true;
  }

  async findById(id: string): Promise<KnowledgeEntry | null> {
    const row = this.db.prepare('SELECT * FROM entries WHERE id = ?').get(id) as EntryRow | undefined;
    return row ? this.rowToEntry(row) : null;
  }

  /**
   * Vector cosine similarity search using Ollama bge-m3 embeddings.
   * Returns null if embedding generation fails or no embeddings exist (graceful fallback).
   */
  private async vectorSearch(text: string, conditions: string[], params: unknown[], limit: number): Promise<SearchResult[] | null> {
    try {
      // Check if any entries have embeddings
      const embCount = (this.db.prepare("SELECT COUNT(*) as cnt FROM entries WHERE embedding IS NOT NULL AND status = 'active' AND type != 'intent'").get() as { cnt: number }).cnt;
      if (embCount === 0) return null;

      const { createEmbeddingProvider } = await import('../embedding/create-provider.js');
      const embedder = createEmbeddingProvider(); // defaults to Ollama bge-m3
      const queryVector = await embedder.embed(text);

      if (!queryVector || queryVector.length === 0) return null;

      // Fetch entries with embeddings that match filters
      const filterClause = conditions.length > 0 ? ' AND ' + conditions.join(' AND ') : '';
      const sql = `SELECT e.*, e.embedding as _embedding FROM entries e WHERE e.embedding IS NOT NULL AND e.type != 'intent'${filterClause}`;
      const rows = this.db.prepare(sql).all(...params) as (EntryRow & { _embedding: Buffer })[];

      // Compute cosine similarity
      const scored: { row: EntryRow; score: number }[] = [];
      for (const row of rows) {
        const buf = row._embedding;
        if (!buf || buf.byteLength === 0) continue;
        const float32 = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
        const vec = Array.from(float32);
        const score = cosineSimilarity(queryVector, vec);
        if (score > 0.3) {
          scored.push({ row, score });
        }
      }

      if (scored.length === 0) return null;

      // Sort by score descending, take top N
      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, limit).map(({ row, score }) => ({
        entry: this.rowToEntry(row),
        score,
      }));
    } catch {
      // Embedding generation failed — graceful fallback
      return null;
    }
  }

  async search(query: SemanticQuery): Promise<SearchResult[]> {
    const limit = query.topK ?? 10;
    const conditions: string[] = [];
    const params: unknown[] = [];

    // Domain knowledge search is separate from intent retrieval.
    if (!query.filters?.types || query.filters.types.length === 0) {
      conditions.push(`e.type != ?`);
      params.push('intent');
    }

    if (query.filters?.types && query.filters.types.length > 0) {
      if (query.filters.types.includes('intent' as never)) {
        conditions.push('1 = 0');
      } else {
        conditions.push(`e.type IN (${query.filters.types.map(() => '?').join(', ')})`);
        params.push(...query.filters.types);
      }
    }
    if (query.filters?.status && query.filters.status.length > 0) {
      conditions.push(`e.status IN (${query.filters.status.map(() => '?').join(', ')})`);
      params.push(...query.filters.status);
    } else {
      // FR-N09: Default filter — exclude superseded entries unless explicitly requested
      conditions.push(`e.status != ?`);
      params.push('superseded');
    }
    if (query.filters?.domain) {
      conditions.push('e.domain = ?');
      params.push(query.filters.domain);
    }
    if (query.filters?.timeRange?.from) {
      conditions.push('e.created_at >= ?');
      params.push(query.filters.timeRange.from.toISOString());
    }
    if (query.filters?.timeRange?.to) {
      conditions.push('e.created_at <= ?');
      params.push(query.filters.timeRange.to.toISOString());
    }

    if (query.text) {
      // Vector cosine similarity search — the only search path in production
      const vectorResults = await this.vectorSearch(query.text, conditions, params, limit);
      if (vectorResults && vectorResults.length > 0) {
        return vectorResults;
      }

      // In test environments without real models, use in-memory content match as fallback
      if (shouldBypassExternalModelsInTests()) {
        const filterClause = conditions.length > 0 ? ' WHERE ' + conditions.join(' AND ') : '';
        const allRows = this.db.prepare(
          `SELECT * FROM entries e${filterClause} ORDER BY e.updated_at DESC LIMIT 100`
        ).all(...params) as EntryRow[];

        // Build search terms: full text + CJK bigrams + ASCII words
        const searchTerms = [query.text!.toLowerCase()];
        const cjk = query.text!.replace(/[^\u4e00-\u9fff]/g, '');
        for (let i = 0; i < cjk.length - 1; i++) {
          searchTerms.push(cjk.slice(i, i + 2));
        }
        const words = query.text!.match(/[a-zA-Z0-9]+/g) ?? [];
        searchTerms.push(...words.filter(w => w.length >= 2).map(w => w.toLowerCase()));

        const matched = allRows.filter(row => {
          const haystack = `${row.title} ${row.content} ${row.summary}`.toLowerCase();
          return searchTerms.some(term => haystack.includes(term));
        }).slice(0, limit);

        return matched.map(row => ({
          entry: this.rowToEntry(row),
          score: 0.5,
        }));
      }

      // Embedding unavailable or no results — throw with guidance
      throw new Error(
        "KIVO 向量检索不可用。请确认 embedding provider 已配置且服务已启动。\n" +
        "运行 'kivo init' 进行配置，或手动设置 embedding.provider / embedding.model / embedding.baseUrl\n" +
        "推荐方案: ollama serve && ollama pull bge-m3"
      );
    }

    // No text query but has filters — return filtered entries
    if (conditions.length > 0) {
      const filterClause = 'WHERE ' + conditions.join(' AND ');
      const sql = `SELECT e.* FROM entries e ${filterClause} ORDER BY e.created_at DESC LIMIT ?`;
      const rows = this.db.prepare(sql).all(...params, limit) as EntryRow[];
      return rows.map(row => ({
        entry: this.rowToEntry(row),
        score: 1.0,
      }));
    }

    return [];
  }

  async updateStatus(id: string, status: EntryStatus): Promise<void> {
    const now = new Date().toISOString();
    this.db.prepare('UPDATE entries SET status = ?, updated_at = ? WHERE id = ?').run(status, now, id);
  }

  async getVersionHistory(id: string): Promise<KnowledgeEntry[]> {
    const rows = this.db.prepare(
      'SELECT * FROM entries WHERE id = ? OR supersedes = ? ORDER BY version ASC'
    ).all(id, id) as EntryRow[];
    return rows.map(r => this.rowToEntry(r));
  }

  async findByType(type: KnowledgeType): Promise<KnowledgeEntry[]> {
    const rows = this.db.prepare('SELECT * FROM entries WHERE type = ?').all(type) as EntryRow[];
    return rows.map(r => this.rowToEntry(r));
  }

  async fullTextSearch(query: string, limit = 20): Promise<KnowledgeEntry[]> {
    // Vector cosine similarity search — the only search path in production
    const vectorResults = await this.vectorSearch(query, [], [], limit);
    if (vectorResults && vectorResults.length > 0) {
      return vectorResults.map(r => r.entry);
    }

    // In test environments without real models, use in-memory content match as fallback
    if (shouldBypassExternalModelsInTests()) {
      const allRows = this.db.prepare(
        `SELECT * FROM entries ORDER BY updated_at DESC LIMIT 100`
      ).all() as EntryRow[];

      const searchTerms = [query.toLowerCase()];
      const cjk = query.replace(/[^\u4e00-\u9fff]/g, '');
      for (let i = 0; i < cjk.length - 1; i++) {
        searchTerms.push(cjk.slice(i, i + 2));
      }
      const words = query.match(/[a-zA-Z0-9]+/g) ?? [];
      searchTerms.push(...words.filter(w => w.length >= 2).map(w => w.toLowerCase()));

      const matched = allRows.filter(row => {
        const haystack = `${row.title} ${row.content} ${row.summary}`.toLowerCase();
        return searchTerms.some(term => haystack.includes(term));
      }).slice(0, limit);

      return matched.map(r => this.rowToEntry(r));
    }

    // Embedding unavailable or no results — throw with guidance
    throw new Error(
      "KIVO 向量检索不可用。请确认 embedding provider 已配置且服务已启动。\n" +
      "运行 'kivo init' 进行配置，或手动设置 embedding.provider / embedding.model / embedding.baseUrl\n" +
      "推荐方案: ollama serve && ollama pull bge-m3"
    );
  }

  async findAll(): Promise<KnowledgeEntry[]> {
    const rows = this.db.prepare('SELECT * FROM entries').all() as EntryRow[];
    return rows.map(r => this.rowToEntry(r));
  }

  async delete(id: string): Promise<void> {
    this.db.prepare('DELETE FROM entries WHERE id = ?').run(id);
  }

  async count(): Promise<number> {
    const row = this.db.prepare('SELECT COUNT(*) as cnt FROM entries').get() as { cnt: number };
    return row.cnt;
  }

  /**
   * Degraded full-text recall (FR-P03 AC7) used when vector search is unavailable.
   * Uses the FTS5 trigram index; falls back to LIKE when the query has no usable
   * trigram tokens (e.g. very short queries). Excludes intent + superseded entries.
   */
  async fallbackFullTextSearch(query: string, limit = 20): Promise<SearchResult[]> {
    const trimmed = query.trim();
    if (!trimmed) return [];

    // FTS5 trigram tokenizer needs >= 3 chars to produce tokens.
    if (trimmed.length >= 3) {
      try {
        const rows = this.db.prepare(`
          SELECT e.*, bm25(entries_fts) AS _rank
          FROM entries_fts
          JOIN entries e ON e.rowid = entries_fts.rowid
          WHERE entries_fts MATCH ?
            AND e.type != 'intent'
            AND e.status != 'superseded'
          ORDER BY _rank ASC
          LIMIT ?
        `).all(trimmed, limit) as Array<EntryRow & { _rank: number }>;
        if (rows.length > 0) {
          return rows.map(row => ({
            entry: this.rowToEntry(row),
            score: ftsRankToScore(row._rank),
          }));
        }
      } catch {
        // MATCH syntax error on punctuation-heavy queries — fall through to LIKE.
      }
    }

    // LIKE fallback for short queries or when FTS yields nothing.
    const like = `%${trimmed.replace(/[%_]/g, '')}%`;
    const rows = this.db.prepare(`
      SELECT * FROM entries
      WHERE type != 'intent'
        AND status != 'superseded'
        AND (title LIKE ? OR content LIKE ? OR summary LIKE ?)
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(like, like, like, limit) as EntryRow[];
    return rows.map(row => ({
      entry: this.rowToEntry(row),
      score: 0.5,
    }));
  }

  /**
   * One-hop graph expansion (FR-P03 AC7) over the given seed entry IDs.
   * Reads the undirected graph_edges table written by subject-graph-writer; for
   * each edge touching a seed, the neighbour on the other end is returned with the
   * edge weight as strength. Self-loops and edges to other seeds are skipped.
   * Returns [] when the graph table has not been created yet.
   */
  async expandGraphOneHop(
    entryIds: string[],
    options?: GraphExpansionOptions,
  ): Promise<GraphExpansionResult[]> {
    if (entryIds.length === 0) return [];

    const tableExists = this.db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='graph_edges'"
    ).get();
    if (!tableExists) return [];

    const seedSet = new Set(entryIds);
    const limitPerSeed = options?.limitPerSeed && options.limitPerSeed > 0 ? options.limitPerSeed : 5;
    const placeholders = entryIds.map(() => '?').join(',');

    const edges = this.db.prepare(`
      SELECT source_id, target_id, association_type, weight
      FROM graph_edges
      WHERE source_id IN (${placeholders}) OR target_id IN (${placeholders})
      ORDER BY weight DESC
    `).all(...entryIds, ...entryIds) as Array<{
      source_id: string;
      target_id: string;
      association_type: string;
      weight: number;
    }>;

    const perSeedCount = new Map<string, number>();
    const results: GraphExpansionResult[] = [];
    const entryCache = new Map<string, KnowledgeEntry | null>();

    for (const edge of edges) {
      const sourceIsSeed = seedSet.has(edge.source_id);
      const seedEntryId = sourceIsSeed ? edge.source_id : edge.target_id;
      const neighbourId = sourceIsSeed ? edge.target_id : edge.source_id;

      // Skip self-loops and edges whose neighbour is itself a seed.
      if (neighbourId === seedEntryId || seedSet.has(neighbourId)) continue;

      const used = perSeedCount.get(seedEntryId) ?? 0;
      if (used >= limitPerSeed) continue;

      if (!entryCache.has(neighbourId)) {
        const row = this.db.prepare('SELECT * FROM entries WHERE id = ?').get(neighbourId) as EntryRow | undefined;
        entryCache.set(neighbourId, row ? this.rowToEntry(row) : null);
      }
      const entry = entryCache.get(neighbourId);
      if (!entry || entry.status === 'superseded') continue;

      perSeedCount.set(seedEntryId, used + 1);
      results.push({
        entry,
        strength: clampWeight(edge.weight),
        relationType: edge.association_type,
        seedEntryId,
      });
    }

    return results;
  }

  async close(): Promise<void> {
    await this.qualityGate.close();
    this.db.close();
  }

  private rowToEntry(row: EntryRow): KnowledgeEntry {
    let similarSentences: string[] | undefined;
    try {
      const parsed = JSON.parse(row.similar_sentences ?? '[]');
      similarSentences = Array.isArray(parsed) && parsed.length > 0 ? parsed : undefined;
    } catch {
      similarSentences = undefined;
    }
    let metadata = undefined;
    try {
      metadata = row.metadata_json ? JSON.parse(row.metadata_json) : undefined;
    } catch {
      metadata = undefined;
    }
    return {
      id: row.id,
      type: row.type as KnowledgeType,
      title: row.title,
      content: row.content,
      summary: row.summary,
      source: JSON.parse(row.source_json) as KnowledgeSource,
      confidence: row.confidence,
      status: row.status as EntryStatus,
      tags: JSON.parse(row.tags_json) as string[],
      domain: row.domain ?? undefined,
      version: row.version,
      supersedes: row.supersedes ?? undefined,
      similarSentences,
      nature: (row.nature ?? undefined) as KnowledgeNature | undefined,
      functionTag: (row.function_tag ?? undefined) as KnowledgeFunction | undefined,
      knowledgeDomain: row.knowledge_domain ?? undefined,
      subjectId: row.subject_id ?? undefined,
      entryType: (row.entry_type ?? undefined) as EntryType | undefined,
      metadata,
      sourceRange: metadata?.sourceRange as KnowledgeEntry['sourceRange'] | undefined,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }
}

interface EntryRow {
  id: string;
  type: string;
  title: string;
  content: string;
  summary: string;
  source_json: string;
  confidence: number;
  status: string;
  tags_json: string;
  domain: string | null;
  version: number;
  supersedes: string | null;
  similar_sentences: string | null;
  nature: string | null;
  function_tag: string | null;
  knowledge_domain: string | null;
  subject_id: string | null;
  entry_type: string | null;
  metadata_json: string | null;
  created_at: string;
  updated_at: string;
  rowid?: number;
}
