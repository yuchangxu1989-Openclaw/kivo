/**
 * Paginated queries — SQL-level LIMIT/OFFSET for the entries table.
 * Avoids loading all entries into memory for pagination.
 *
 * Uses the same DB connection as KnowledgeRepository (via getRepository()),
 * but accesses the underlying better-sqlite3 instance directly for
 * optimized queries not exposed by the StorageProvider SPI.
 */

import Database from 'better-sqlite3';
import type { KnowledgeEntry as CoreKnowledgeEntry, KnowledgeType, EntryStatus, KnowledgeSource, KnowledgeNature, KnowledgeFunction } from '@self-evolving-harness/kivo';
import { resolveKivoDbPath } from '@/lib/db';

type CoreSourceRange = {
  documentId: string;
  page?: number;
  paragraph?: number | { start: number; end: number };
  section?: string;
  originalText: string;
};

type KnowledgeEntry = CoreKnowledgeEntry & { sourceRange?: CoreSourceRange };

let db: Database.Database | null = null;
let dbPath: string | null = null;

function getDb(): Database.Database {
  const nextPath = resolveKivoDbPath();
  if (!db || dbPath !== nextPath) {
    db?.close();
    db = new Database(nextPath);
    dbPath = nextPath;
    db.pragma('journal_mode = WAL');
  }
  return db;
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
}

function safeJsonParse<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw || raw.trim() === '') return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

const DEFAULT_SOURCE: KnowledgeSource = { type: 'system', reference: 'unknown', timestamp: new Date() };
const WIKI_ENTRY_TYPES = ['wiki_space', 'wiki_directory', 'wiki_page'] as const;
const DOMAIN_EXCLUDED_TYPES = [...WIKI_ENTRY_TYPES, 'intent'];
const KNOWLEDGE_TYPE_VALUES = ['fact', 'methodology', 'decision', 'experience', 'meta'];

function rowToEntry(row: EntryRow): KnowledgeEntry {
  const similarSentencesParsed = safeJsonParse<string[]>(row.similar_sentences, []);
  const similarSentences = similarSentencesParsed.length > 0 ? similarSentencesParsed : undefined;
  const metadata = safeJsonParse<Record<string, unknown> | undefined>(row.metadata_json, undefined);

  return {
    id: row.id,
    type: row.type as KnowledgeType,
    title: row.title,
    content: row.content,
    summary: row.summary,
    source: safeJsonParse<KnowledgeSource>(row.source_json, DEFAULT_SOURCE),
    confidence: row.confidence,
    status: row.status as EntryStatus,
    tags: safeJsonParse<string[]>(row.tags_json, []),
    domain: row.domain ?? undefined,
    version: row.version,
    supersedes: row.supersedes ?? undefined,
    similarSentences,
    nature: (row.nature ?? undefined) as KnowledgeNature | undefined,
    functionTag: (row.function_tag ?? undefined) as KnowledgeFunction | undefined,
    knowledgeDomain: row.knowledge_domain ?? undefined,
    metadata: metadata as KnowledgeEntry['metadata'],
    sourceRange: metadata?.sourceRange as CoreSourceRange | undefined,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

export interface PaginatedOptions {
  type?: string;
  status?: string;
  domain?: string;
  source?: string;
  from?: string;   // ISO date string
  to?: string;     // ISO date string
  sort?: string;    // e.g. '-updatedAt', 'createdAt', '-confidence'
  page: number;
  pageSize: number;
  excludeTypes?: string[];
  includeTypes?: string[];
}

export interface PaginatedResult<T> {
  items: T[];
  total: number;
}

/**
 * SQL-level paginated query for entries.
 */
export function findEntriesPaginated(opts: PaginatedOptions): PaginatedResult<KnowledgeEntry> {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (opts.type) {
    if (opts.type === 'intent') {
      conditions.push('1 = 0');
    } else {
      conditions.push('type = ?');
      params.push(opts.type);
    }
  }
  if (opts.includeTypes && opts.includeTypes.length > 0) {
    conditions.push(`type IN (${opts.includeTypes.map(() => '?').join(', ')})`);
    params.push(...opts.includeTypes);
  }
  if (!opts.type && (!opts.excludeTypes || !opts.excludeTypes.includes('intent'))) {
    conditions.push('type != ?');
    params.push('intent');
  }
  if (opts.excludeTypes && opts.excludeTypes.length > 0) {
    conditions.push(`type NOT IN (${opts.excludeTypes.map(() => '?').join(', ')})`);
    params.push(...opts.excludeTypes);
  }
  if (opts.status) {
    conditions.push('status = ?');
    params.push(opts.status);
  }
  if (opts.domain) {
    conditions.push('LOWER(domain) LIKE ?');
    params.push(`%${opts.domain.toLowerCase()}%`);
  }
  if (opts.source) {
    conditions.push('LOWER(source_json) LIKE ?');
    params.push(`%${opts.source.toLowerCase()}%`);
  }
  if (opts.from) {
    conditions.push('created_at >= ?');
    params.push(opts.from);
  }
  if (opts.to) {
    conditions.push('created_at <= ?');
    params.push(opts.to);
  }

  const where = conditions.length > 0 ? ' WHERE ' + conditions.join(' AND ') : '';

  // Sort
  let orderBy: string;
  switch (opts.sort) {
    case '-createdAt':
    case 'createdAt':
      orderBy = 'created_at DESC';
      break;
    case '-confidence':
    case 'confidence':
      orderBy = 'confidence DESC';
      break;
    case '-updatedAt':
    case 'updatedAt':
    default:
      orderBy = 'updated_at DESC';
      break;
  }

  // Count
  const countSql = `SELECT COUNT(*) as cnt FROM entries${where}`;
  const countRow = getDb().prepare(countSql).get(...params) as { cnt: number };
  const total = countRow.cnt;

  // Paginated fetch
  const offset = (opts.page - 1) * opts.pageSize;
  const dataSql = `SELECT * FROM entries${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`;
  const rows = getDb().prepare(dataSql).all(...params, opts.pageSize, offset) as EntryRow[];

  return {
    items: rows.map(rowToEntry),
    total,
  };
}

/**
 * Get aggregated counts by type and status (for dashboard summary).
 */
export function getEntryCounts(): {
  total: number;
  byType: Record<string, number>;
  byStatus: Record<string, number>;
  lastUpdated: string | null;
} {
  const d = getDb();
  const placeholders = DOMAIN_EXCLUDED_TYPES.map(() => '?').join(', ');
  const totalRow = d.prepare(`SELECT COUNT(*) as cnt FROM entries WHERE type NOT IN (${placeholders})`).get(...DOMAIN_EXCLUDED_TYPES) as { cnt: number };
  const typeRows = d.prepare(`SELECT type, COUNT(*) as cnt FROM entries WHERE type NOT IN (${placeholders}) GROUP BY type`).all(...DOMAIN_EXCLUDED_TYPES) as Array<{ type: string; cnt: number }>;
  const statusRows = d.prepare(`SELECT status, COUNT(*) as cnt FROM entries WHERE type NOT IN (${placeholders}) GROUP BY status`).all(...DOMAIN_EXCLUDED_TYPES) as Array<{ status: string; cnt: number }>;
  const lastRow = d.prepare(`SELECT MAX(updated_at) as last_updated FROM entries WHERE type NOT IN (${placeholders})`).get(...DOMAIN_EXCLUDED_TYPES) as { last_updated: string | null };

  const byType: Record<string, number> = {};
  for (const r of typeRows) byType[r.type] = r.cnt;

  const byStatus: Record<string, number> = {};
  for (const r of statusRows) byStatus[r.status] = r.cnt;

  return {
    total: totalRow.cnt,
    byType,
    byStatus,
    lastUpdated: lastRow.last_updated,
  };
}

/**
 * Batch fetch entries by IDs — eliminates N+1 queries.
 */
export function findEntriesByIds(ids: string[]): KnowledgeEntry[] {
  if (ids.length === 0) return [];

  const placeholders = ids.map(() => '?').join(', ');
  const sql = `SELECT * FROM entries WHERE id IN (${placeholders}) AND status = 'active' AND type != 'intent'`;
  const rows = getDb().prepare(sql).all(...ids) as EntryRow[];
  return rows.map(rowToEntry);
}

/**
 * Get entries within a time window (for trend calculations).
 */
export function countEntriesInWindow(fromDate: string, toDate?: string): number {
  if (toDate) {
    const row = getDb().prepare(
      'SELECT COUNT(*) as cnt FROM entries WHERE created_at >= ? AND created_at < ? AND type IN (' + KNOWLEDGE_TYPE_VALUES.map(() => '?').join(', ') + ')'
    ).get(fromDate, toDate, ...KNOWLEDGE_TYPE_VALUES) as { cnt: number };
    return row.cnt;
  }
  const row = getDb().prepare(
    'SELECT COUNT(*) as cnt FROM entries WHERE created_at >= ? AND type IN (' + KNOWLEDGE_TYPE_VALUES.map(() => '?').join(', ') + ')'
  ).get(fromDate, ...KNOWLEDGE_TYPE_VALUES) as { cnt: number };
  return row.cnt;
}

export function getActiveTypeCounts(): Record<string, number> {
  const rows = getDb().prepare(
    `SELECT type, COUNT(*) as cnt FROM entries WHERE status = 'active' AND type IN (${KNOWLEDGE_TYPE_VALUES.map(() => '?').join(', ')}) GROUP BY type`
  ).all(...KNOWLEDGE_TYPE_VALUES) as Array<{ type: string; cnt: number }>;

  const byType: Record<string, number> = {};
  for (const row of rows) byType[row.type] = row.cnt;
  return byType;
}

export function getConfidenceBuckets(): {
  high: number;
  medium: number;
  low: number;
  unknown: number;
} {
  const row = getDb().prepare(`
    SELECT
      SUM(CASE WHEN confidence IS NULL THEN 1 ELSE 0 END) as unknown,
      SUM(CASE WHEN confidence >= 0.85 THEN 1 ELSE 0 END) as high,
      SUM(CASE WHEN confidence >= 0.6 AND confidence < 0.85 THEN 1 ELSE 0 END) as medium,
      SUM(CASE WHEN confidence < 0.6 THEN 1 ELSE 0 END) as low
    FROM entries
    WHERE type IN (${KNOWLEDGE_TYPE_VALUES.map(() => '?').join(', ')})
  `).get(...KNOWLEDGE_TYPE_VALUES) as {
    high: number | null;
    medium: number | null;
    low: number | null;
    unknown: number | null;
  };

  return {
    high: row.high ?? 0,
    medium: row.medium ?? 0,
    low: row.low ?? 0,
    unknown: row.unknown ?? 0,
  };
}

export interface DailyCountPoint {
  date: string;
  count: number;
}

export function getDailyEntryCounts(days: number): DailyCountPoint[] {
  const points: DailyCountPoint[] = [];
  const now = new Date();

  for (let i = days - 1; i >= 0; i--) {
    const dayStart = new Date(now);
    dayStart.setDate(dayStart.getDate() - i);
    dayStart.setHours(0, 0, 0, 0);

    const dayEnd = new Date(dayStart);
    dayEnd.setDate(dayEnd.getDate() + 1);

    points.push({
      date: dayStart.toISOString().slice(0, 10),
      count: countEntriesInWindow(dayStart.toISOString(), dayEnd.toISOString()),
    });
  }

  return points;
}


/**
 * Count total entries and starter template entries. Used by fresh-install status.
 */
export function countEntriesBySource(): { total: number; seedCount: number } {
  const d = getDb();
  const totalRow = d.prepare("SELECT COUNT(*) as cnt FROM entries WHERE type != 'intent'").get() as { cnt: number };
  const seedRow = d.prepare("SELECT COUNT(*) as cnt FROM entries WHERE source_json LIKE '%seed:demo-data%'").get() as { cnt: number };
  return { total: totalRow.cnt, seedCount: seedRow.cnt };
}

/**
 * Remove starter template entries.
 */
export function deleteSeedEntries(): number {
  const result = getDb().prepare("DELETE FROM entries WHERE source_json LIKE '%seed:demo-data%'").run();
  return Number(result.changes ?? 0);
}
