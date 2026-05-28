/**
 * Operation Log DB — persistent operation event store (FR-W04).
 *
 * Event types (AC1):
 * - knowledge_change: 知识条目变动(创建/删除/合并,含来源标注)
 * - document_import: 文档导入事件(文件名+产出知识数)
 * - research_complete: 调研完成事件(主题+报告路径)
 * - governance_run: 治理运行摘要(合并N条/清理N条)
 * - vectorization_batch: 向量化批次完成
 */

import Database from 'better-sqlite3';
import path from 'path';

function resolveDbPath(): string {
  return process.env.KIVO_DB_PATH || path.resolve(process.cwd(), '../kivo.db');
}

// ─── Types ──────────────────────────────────────────────────────────────────

export type OperationEventType =
  | 'knowledge_change'
  | 'document_import'
  | 'research_complete'
  | 'governance_run'
  | 'vectorization_batch';

export interface OperationLogEntry {
  id: number;
  event_type: OperationEventType;
  title: string;
  detail: string;
  /** JSON metadata for structured info (source, counts, paths, etc.) */
  metadata_json: string;
  created_at: string;
}

export interface OperationLogFilter {
  event_type?: OperationEventType | 'all';
  limit?: number;
  offset?: number;
  since_id?: number;
}

// ─── DB Setup ───────────────────────────────────────────────────────────────

let db: Database.Database | null = null;
let dbPath: string | null = null;

function getDb(): Database.Database {
  const nextPath = resolveDbPath();
  if (!db || dbPath !== nextPath) {
    if (db) db.close();
    dbPath = nextPath;
    db = new Database(nextPath);
    db.pragma('journal_mode = WAL');
    ensureTable(db);
  }
  return db;
}

function ensureTable(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS operation_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      title TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_operation_logs_event_type ON operation_logs(event_type);
    CREATE INDEX IF NOT EXISTS idx_operation_logs_created_at ON operation_logs(created_at);
  `);
}

// ─── Write ──────────────────────────────────────────────────────────────────

export function writeOperationLog(
  event_type: OperationEventType,
  title: string,
  detail: string = '',
  metadata: Record<string, unknown> = {},
): OperationLogEntry {
  const database = getDb();
  const now = new Date().toISOString();
  const metadataJson = JSON.stringify(metadata);

  const stmt = database.prepare(`
    INSERT INTO operation_logs (event_type, title, detail, metadata_json, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  const result = stmt.run(event_type, title, detail, metadataJson, now);

  const entry: OperationLogEntry = {
    id: result.lastInsertRowid as number,
    event_type,
    title,
    detail,
    metadata_json: metadataJson,
    created_at: now,
  };

  // Notify SSE listeners
  notifyListeners(entry);

  return entry;
}

// ─── Read ───────────────────────────────────────────────────────────────────

export function queryOperationLogs(filter: OperationLogFilter = {}): {
  items: OperationLogEntry[];
  total: number;
} {
  const database = getDb();
  const { event_type = 'all', limit = 50, offset = 0 } = filter;

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (event_type && event_type !== 'all') {
    conditions.push('event_type = ?');
    params.push(event_type);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const countRow = database.prepare(`SELECT COUNT(*) as cnt FROM operation_logs ${where}`).get(...params) as { cnt: number };
  const total = countRow.cnt;

  const rows = database.prepare(
    `SELECT id, event_type, title, detail, metadata_json, created_at
     FROM operation_logs ${where}
     ORDER BY id DESC
     LIMIT ? OFFSET ?`
  ).all(...params, limit, offset) as OperationLogEntry[];

  return { items: rows, total };
}

/**
 * Get events since a given ID (for SSE reconnection replay — AC4).
 */
export function getOperationLogsSinceId(sinceId: number): OperationLogEntry[] {
  const database = getDb();
  return database.prepare(
    `SELECT id, event_type, title, detail, metadata_json, created_at
     FROM operation_logs
     WHERE id > ?
     ORDER BY id ASC
     LIMIT 200`
  ).all(sinceId) as OperationLogEntry[];
}

/**
 * Get the latest event ID (for initial SSE connection).
 */
export function getLatestOperationLogId(): number {
  const database = getDb();
  const row = database.prepare('SELECT MAX(id) as max_id FROM operation_logs').get() as { max_id: number | null };
  return row.max_id ?? 0;
}

// ─── SSE Listener Registry (AC3) ───────────────────────────────────────────

type Listener = (entry: OperationLogEntry) => void;
const listeners = new Set<Listener>();

export function addOperationLogListener(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

function notifyListeners(entry: OperationLogEntry): void {
  for (const fn of listeners) {
    try { fn(entry); } catch { /* ignore */ }
  }
}
