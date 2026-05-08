/**
 * SQLiteKnowledgeStore — SQLite-backed implementation of StorageAdapter
 *
 * Drop-in replacement for MemoryKnowledgeStore. Used by F domain (RuleRegistry)
 * and H domain (DictionaryService) to persist KnowledgeEntry data across restarts.
 */

import Database from 'better-sqlite3';
import type { KnowledgeEntry, KnowledgeSource, EntryStatus, KnowledgeType, KnowledgeNature, KnowledgeFunction } from '../types/index.js';
import { shortenKnowledgeTitle } from '../extraction/extraction-utils.js';
import type {
  KnowledgeFilter,
  PaginationOptions,
  QueryResult,
  StorageAdapter,
  TimeRangeFilter,
} from './storage-types.js';

export interface SQLiteKnowledgeStoreOptions {
  /** An already-opened better-sqlite3 Database instance (shared with other stores). */
  db: Database.Database;
  /** Table name prefix to isolate different stores in the same DB. */
  tablePrefix?: string;
}

export class SQLiteKnowledgeStore implements StorageAdapter {
  private readonly db: Database.Database;
  private readonly table: string;
  private readonly historyTable: string;

  constructor(options: SQLiteKnowledgeStoreOptions) {
    this.db = options.db;
    const prefix = options.tablePrefix ?? 'kstore';
    this.table = `${prefix}_entries`;
    this.historyTable = `${prefix}_version_history`;
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${this.table} (
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
        similar_sentences TEXT DEFAULT '[]',
        nature TEXT,
        function_tag TEXT,
        knowledge_domain TEXT,
        metadata_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS ${this.historyTable} (
        id TEXT NOT NULL,
        version INTEGER NOT NULL,
        data_json TEXT NOT NULL,
        PRIMARY KEY (id, version)
      );
    `);
  }

  async save(entry: KnowledgeEntry): Promise<KnowledgeEntry> {
    const normalized = cloneEntry(entry);
    const row = entryToRow(normalized);

    this.db.prepare(`
      INSERT OR REPLACE INTO ${this.table}
        (id, type, title, content, summary, source_json, confidence, status,
         tags_json, domain, version, supersedes, similar_sentences,
         nature, function_tag, knowledge_domain, metadata_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.id, row.type, row.title, row.content, row.summary, row.source_json,
      row.confidence, row.status, row.tags_json, row.domain, row.version,
      row.supersedes, row.similar_sentences, row.nature, row.function_tag,
      row.knowledge_domain, row.metadata_json, row.created_at, row.updated_at
    );

    // Append to version history
    this.db.prepare(`
      INSERT OR REPLACE INTO ${this.historyTable} (id, version, data_json)
      VALUES (?, ?, ?)
    `).run(normalized.id, normalized.version, JSON.stringify(entryToRow(normalized)));

    return cloneEntry(normalized);
  }

  async saveMany(entries: KnowledgeEntry[]): Promise<KnowledgeEntry[]> {
    const saved: KnowledgeEntry[] = [];
    const txn = this.db.transaction(() => {
      for (const entry of entries) {
        // Inline save logic to avoid async in transaction
        const normalized = cloneEntry(entry);
        const row = entryToRow(normalized);
        this.db.prepare(`
          INSERT OR REPLACE INTO ${this.table}
            (id, type, title, content, summary, source_json, confidence, status,
             tags_json, domain, version, supersedes, similar_sentences,
             nature, function_tag, knowledge_domain, metadata_json, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          row.id, row.type, row.title, row.content, row.summary, row.source_json,
          row.confidence, row.status, row.tags_json, row.domain, row.version,
          row.supersedes, row.similar_sentences, row.nature, row.function_tag,
          row.knowledge_domain, row.metadata_json, row.created_at, row.updated_at
        );
        this.db.prepare(`
          INSERT OR REPLACE INTO ${this.historyTable} (id, version, data_json)
          VALUES (?, ?, ?)
        `).run(normalized.id, normalized.version, JSON.stringify(entryToRow(normalized)));
        saved.push(cloneEntry(normalized));
      }
    });
    txn();
    return saved;
  }

  async get(id: string): Promise<KnowledgeEntry | null> {
    const row = this.db.prepare(`SELECT * FROM ${this.table} WHERE id = ?`).get(id) as StoreRow | undefined;
    return row ? rowToEntry(row) : null;
  }

  async update(
    id: string,
    patch: Partial<Omit<KnowledgeEntry, 'id' | 'createdAt' | 'version'>>
  ): Promise<KnowledgeEntry | null> {
    const existing = await this.get(id);
    if (!existing) return null;

    const updatedAt = patch.updatedAt ?? new Date();
    const next: KnowledgeEntry = {
      ...existing,
      ...patch,
      id: existing.id,
      createdAt: new Date(existing.createdAt),
      updatedAt: new Date(updatedAt),
      version: existing.version + 1,
      source: patch.source ? cloneSource(patch.source) : cloneSource(existing.source),
      tags: patch.tags ? [...patch.tags] : [...existing.tags],
      metadata: mergeMetadata(existing.metadata, patch.metadata),
    };

    return this.save(next);
  }

  async delete(id: string): Promise<boolean> {
    const result = this.db.prepare(`DELETE FROM ${this.table} WHERE id = ?`).run(id);
    return result.changes > 0;
  }

  async deleteMany(ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;
    const placeholders = ids.map(() => '?').join(', ');
    const result = this.db.prepare(`DELETE FROM ${this.table} WHERE id IN (${placeholders})`).run(...ids);
    return result.changes;
  }

  async query(
    filter: KnowledgeFilter = {},
    options: PaginationOptions = {}
  ): Promise<QueryResult<KnowledgeEntry>> {
    const offset = Math.max(0, Math.floor(options.offset ?? filter.pagination?.offset ?? 0));
    const limit = options.limit ?? filter.pagination?.limit ?? Number.MAX_SAFE_INTEGER;
    const safeLimit = limit <= 0 ? Number.MAX_SAFE_INTEGER : Math.floor(limit);

    const conditions: string[] = [];
    const params: unknown[] = [];

    // Type filter
    const types = normalizeArray(filter.type);
    if (types) {
      conditions.push(`type IN (${types.map(() => '?').join(', ')})`);
      params.push(...types);
    }

    // Domain filter
    const domains = normalizeArray(filter.domain);
    if (domains) {
      conditions.push(`domain IN (${domains.map(() => '?').join(', ')})`);
      params.push(...domains);
    }

    // Status filter
    const statuses = normalizeArray(filter.status);
    if (statuses) {
      conditions.push(`status IN (${statuses.map(() => '?').join(', ')})`);
      params.push(...statuses);
    }

    // Confidence filter
    if (filter.confidence?.min !== undefined) {
      conditions.push('confidence >= ?');
      params.push(filter.confidence.min);
    }
    if (filter.confidence?.max !== undefined) {
      conditions.push('confidence <= ?');
      params.push(filter.confidence.max);
    }

    // Time range filters
    if (filter.createdAt?.from) {
      conditions.push('created_at >= ?');
      params.push(filter.createdAt.from.toISOString());
    }
    if (filter.createdAt?.to) {
      conditions.push('created_at <= ?');
      params.push(filter.createdAt.to.toISOString());
    }
    if (filter.updatedAt?.from) {
      conditions.push('updated_at >= ?');
      params.push(filter.updatedAt.from.toISOString());
    }
    if (filter.updatedAt?.to) {
      conditions.push('updated_at <= ?');
      params.push(filter.updatedAt.to.toISOString());
    }

    const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

    // Get total count
    const countRow = this.db.prepare(
      `SELECT COUNT(*) as cnt FROM ${this.table} ${whereClause}`
    ).get(...params) as { cnt: number };

    // Get paginated results
    const rows = this.db.prepare(
      `SELECT * FROM ${this.table} ${whereClause} ORDER BY updated_at DESC LIMIT ? OFFSET ?`
    ).all(...params, safeLimit, offset) as StoreRow[];

    const items = rows.map(rowToEntry);

    // Post-filter for tags (SQLite doesn't natively support JSON array containment easily)
    const filtered = filter.tags && filter.tags.length > 0
      ? items.filter(entry => {
          const tagSet = new Set(entry.tags);
          return filter.tags!.every(tag => tagSet.has(tag));
        })
      : items;

    // Post-filter for source
    const sources = normalizeArray(filter.source);
    const finalItems = sources
      ? filtered.filter(entry => {
          return sources.includes(entry.source.reference) || sources.includes(entry.source.type);
        })
      : filtered;

    return {
      items: finalItems,
      total: countRow.cnt,
      offset,
      limit: safeLimit,
      hasMore: offset + rows.length < countRow.cnt,
    };
  }

  async getVersionHistory(id: string): Promise<KnowledgeEntry[]> {
    const rows = this.db.prepare(
      `SELECT data_json FROM ${this.historyTable} WHERE id = ? ORDER BY version ASC`
    ).all(id) as { data_json: string }[];

    return rows.map(r => rowToEntry(JSON.parse(r.data_json) as StoreRow));
  }
}

// ── Helpers ──

interface StoreRow {
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
}

function entryToRow(entry: KnowledgeEntry): StoreRow {
  return {
    id: entry.id,
    type: entry.type,
    title: entry.title,
    content: entry.content,
    summary: entry.summary ?? '',
    source_json: JSON.stringify(entry.source),
    confidence: entry.confidence,
    status: entry.status,
    tags_json: JSON.stringify(entry.tags),
    domain: entry.domain ?? null,
    version: entry.version,
    supersedes: entry.supersedes ?? null,
    similar_sentences: JSON.stringify(entry.similarSentences ?? []),
    nature: entry.nature ?? null,
    function_tag: entry.functionTag ?? null,
    knowledge_domain: entry.knowledgeDomain ?? null,
    metadata_json: entry.metadata ? JSON.stringify(entry.metadata) : null,
    created_at: entry.createdAt.toISOString(),
    updated_at: entry.updatedAt.toISOString(),
  };
}

function rowToEntry(row: StoreRow): KnowledgeEntry {
  let similarSentences: string[] | undefined;
  try {
    const parsed = JSON.parse(row.similar_sentences ?? '[]');
    similarSentences = Array.isArray(parsed) && parsed.length > 0 ? parsed : undefined;
  } catch {
    similarSentences = undefined;
  }

  let metadata: KnowledgeEntry['metadata'];
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

function cloneEntry(entry: KnowledgeEntry): KnowledgeEntry {
  return {
    ...entry,
    title: shortenKnowledgeTitle(entry.title, entry.content),
    source: cloneSource(entry.source),
    tags: [...entry.tags],
    similarSentences: entry.similarSentences ? [...entry.similarSentences] : undefined,
    metadata: entry.metadata ? JSON.parse(JSON.stringify(entry.metadata)) : undefined,
    createdAt: new Date(entry.createdAt),
    updatedAt: new Date(entry.updatedAt),
  };
}

function cloneSource(source: KnowledgeSource): KnowledgeSource {
  return {
    ...source,
    timestamp: new Date(source.timestamp),
  };
}

function mergeMetadata(
  existing: KnowledgeEntry['metadata'],
  patch: KnowledgeEntry['metadata']
): KnowledgeEntry['metadata'] {
  if (!existing && !patch) return undefined;
  return {
    ...(existing ?? {}),
    ...(patch ?? {}),
    domainData:
      existing?.domainData || patch?.domainData
        ? { ...(existing?.domainData ?? {}), ...(patch?.domainData ?? {}) }
        : undefined,
    embedding:
      existing?.embedding || patch?.embedding
        ? {
            status: 'pending_rebuild' as const,
            ...(existing?.embedding ?? {}),
            ...(patch?.embedding ?? {}),
          }
        : undefined,
  };
}

function normalizeArray<T>(value?: T | T[]): T[] | null {
  if (value === undefined) return null;
  return Array.isArray(value) ? value : [value];
}
