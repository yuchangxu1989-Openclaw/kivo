/**
 * SQLiteProvider — 默认存储后端
 * 使用 better-sqlite3，FTS5 全文索引，事务保证原子性。
 */

import Database from 'better-sqlite3';
import type { KnowledgeEntry, EntryStatus, KnowledgeType, KnowledgeSource, KnowledgeNature, KnowledgeFunction } from '../types/index.js';
import { shortenKnowledgeTitle } from '../extraction/extraction-utils.js';
import { shouldBypassExternalModelsInTests } from '../utils/test-runtime.js';
import type { StorageProvider, SemanticQuery, SearchResult, SaveOptions } from './storage-provider.js';
import { IntakeQualityGate, type QualityGateDecision } from './intake-quality-gate.js';

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

  async save(entry: KnowledgeEntry, options?: SaveOptions): Promise<boolean> {
    const bypassInTests = shouldBypassExternalModelsInTests();

    // FR-N05: Hard confidence gate — reject entries below 0.7
    const CONFIDENCE_THRESHOLD = 0.7;
    if (!bypassInTests && entry.confidence < CONFIDENCE_THRESHOLD) {
      console.warn(
        `[KIVO] Rejected entry "${entry.title}" — confidence ${entry.confidence} below threshold ${CONFIDENCE_THRESHOLD}`
      );
      return false;
    }

    const isCreate = !this.db.prepare('SELECT 1 FROM entries WHERE id = ?').get(entry.id);
    let gateDecision: QualityGateDecision | null = null;

    if (isCreate) {
      gateDecision = await this.qualityGate.evaluate(entry, {
        skip: options?.skipQualityGate || bypassInTests,
      });
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
    const sourceJson = JSON.stringify(entry.source);
    const tagsJson = JSON.stringify(entry.tags);
    const similarSentencesJson = JSON.stringify(entry.similarSentences ?? []);
    const nature = entry.nature ?? null;
    const functionTag = entry.functionTag ?? null;
    const knowledgeDomain = entry.knowledgeDomain ?? null;
    const metadataJson = entry.metadata ? JSON.stringify(entry.metadata) : null;
    const embeddingBlob = gateDecision?.embedding ? Buffer.from(new Float32Array(gateDecision.embedding).buffer) : null;

    const txn = this.db.transaction(() => {
      const existing = this.db.prepare('SELECT id, version FROM entries WHERE id = ?').get(entry.id) as { id: string; version: number } | undefined;

      if (existing) {
        this.db.prepare(`
          UPDATE entries SET type = ?, title = ?, content = ?, summary = ?, source_json = ?,
            confidence = ?, status = ?, tags_json = ?, domain = ?, version = ?,
            supersedes = ?, similar_sentences = ?, nature = ?, function_tag = ?, knowledge_domain = ?, metadata_json = ?, updated_at = ?
          WHERE id = ?
        `).run(
          entry.type, normalizedTitle, entry.content, entry.summary, sourceJson,
          entry.confidence, entry.status, tagsJson, entry.domain ?? null,
          existing.version + 1, entry.supersedes ?? null, similarSentencesJson,
          nature, functionTag, knowledgeDomain, metadataJson, now, entry.id
        );
      } else {
        this.db.prepare(`
          INSERT INTO entries (id, type, title, content, summary, source_json, confidence, status, tags_json, domain, version, supersedes, similar_sentences, nature, function_tag, knowledge_domain, metadata_json, embedding, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          entry.id, entry.type, normalizedTitle, entry.content, entry.summary, sourceJson,
          entry.confidence, entry.status, tagsJson, entry.domain ?? null,
          entry.version ?? 1, entry.supersedes ?? null, similarSentencesJson,
          nature, functionTag, knowledgeDomain, metadataJson, embeddingBlob,
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

  async search(query: SemanticQuery): Promise<SearchResult[]> {
    const limit = query.topK ?? 10;
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (query.filters?.types && query.filters.types.length > 0) {
      conditions.push(`e.type IN (${query.filters.types.map(() => '?').join(', ')})`);
      params.push(...query.filters.types);
    }
    if (query.filters?.status && query.filters.status.length > 0) {
      conditions.push(`e.status IN (${query.filters.status.map(() => '?').join(', ')})`);
      params.push(...query.filters.status);
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
      const filterClause = conditions.length > 0 ? ' AND ' + conditions.join(' AND ') : '';
      let rows: (EntryRow & { rank: number })[] = [];

      // Trigram requires >= 3 chars; try FTS first, fall back to LIKE
      if (query.text.length >= 3) {
        try {
          const sql = `
            SELECT e.*, rank FROM entries e
            JOIN entries_fts ON entries_fts.rowid = e.rowid
            WHERE entries_fts MATCH ?${filterClause}
            ORDER BY rank
            LIMIT ?
          `;
          rows = this.db.prepare(sql).all(query.text, ...params, limit) as (EntryRow & { rank: number })[];
        } catch {
          rows = [];
        }
      }

      // LIKE fallback for short queries or when FTS returns nothing
      if (rows.length === 0) {
        const likeSql = `
          SELECT e.*, -1 as rank FROM entries e
          WHERE (e.title LIKE ? OR e.content LIKE ? OR e.summary LIKE ?)${filterClause}
          ORDER BY e.updated_at DESC
          LIMIT ?
        `;
        const likePattern = `%${query.text}%`;
        rows = this.db.prepare(likeSql).all(likePattern, likePattern, likePattern, ...params, limit) as (EntryRow & { rank: number })[];
      }

      return rows.map(row => ({
        entry: this.rowToEntry(row),
        score: Math.max(0, 1 - Math.abs(row.rank) / 10),
      }));
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
    let rows: EntryRow[] = [];

    // Trigram requires >= 3 chars
    if (query.length >= 3) {
      try {
        rows = this.db.prepare(`
          SELECT e.* FROM entries e
          JOIN entries_fts ON entries_fts.rowid = e.rowid
          WHERE entries_fts MATCH ?
          LIMIT ?
        `).all(query, limit) as EntryRow[];
      } catch {
        rows = [];
      }
    }

    // LIKE fallback
    if (rows.length === 0) {
      const pattern = `%${query}%`;
      rows = this.db.prepare(`
        SELECT * FROM entries
        WHERE title LIKE ? OR content LIKE ? OR summary LIKE ?
        LIMIT ?
      `).all(pattern, pattern, pattern, limit) as EntryRow[];
    }

    return rows.map(r => this.rowToEntry(r));
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
      metadata,
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
  metadata_json: string | null;
  created_at: string;
  updated_at: string;
  rowid?: number;
}
