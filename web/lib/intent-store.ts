import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import type { IntentData, IntentItem } from './demo-dashboard-data';
import { resolveKivoDbPath } from './db';
import { embedQuery, semanticSearchIntents } from './semantic-search';

const DB_PATH = resolveKivoDbPath();

type IntentStatus = 'active' | 'archived';

interface IntentRow {
  id: string;
  name: string;
  description: string;
  why: string | null;
  similar_sentences_json: string | null;
  status: string | null;
  hit_count: number | null;
  last_hit_at: string | null;
  confidence: number | null;
  source_session_id: string | null;
  source_message_id: string | null;
  created_at: string;
  updated_at: string;
  metadata_json: string | null;
}

interface LegacyIntentRow {
  id: string;
  title: string;
  content: string;
  summary: string | null;
  similar_sentences: string | null;
  status: string | null;
  confidence: number | null;
  created_at: string;
  updated_at: string;
  last_hit_at: string | null;
  metadata_json: string | null;
}

let db: Database.Database | null = null;

function getDb(): Database.Database {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    ensureIntentTables(db);
  }
  return db;
}

export function ensureIntentTables(conn: Database.Database): void {
  conn.exec(`
    CREATE TABLE IF NOT EXISTS intents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      embedding BLOB,
      status TEXT NOT NULL DEFAULT 'active',
      hit_count INTEGER NOT NULL DEFAULT 0,
      last_hit_at TEXT,
      confidence REAL NOT NULL DEFAULT 1.0,
      source_session_id TEXT,
      source_message_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  const columns = conn.prepare('PRAGMA table_info(intents)').all() as Array<{ name: string }>;
  const colNames = new Set(columns.map((column) => column.name));
  if (!colNames.has('name')) conn.exec(`ALTER TABLE intents ADD COLUMN name TEXT NOT NULL DEFAULT ''`);
  if (!colNames.has('description')) conn.exec(`ALTER TABLE intents ADD COLUMN description TEXT NOT NULL DEFAULT ''`);
  if (!colNames.has('why')) conn.exec(`ALTER TABLE intents ADD COLUMN why TEXT`);
  if (!colNames.has('similar_sentences_json')) conn.exec(`ALTER TABLE intents ADD COLUMN similar_sentences_json TEXT NOT NULL DEFAULT '[]'`);
  if (!colNames.has('embedding')) conn.exec(`ALTER TABLE intents ADD COLUMN embedding BLOB`);
  if (!colNames.has('status')) conn.exec(`ALTER TABLE intents ADD COLUMN status TEXT NOT NULL DEFAULT 'active'`);
  if (!colNames.has('hit_count')) conn.exec(`ALTER TABLE intents ADD COLUMN hit_count INTEGER NOT NULL DEFAULT 0`);
  if (!colNames.has('last_hit_at')) conn.exec(`ALTER TABLE intents ADD COLUMN last_hit_at TEXT`);
  if (!colNames.has('confidence')) conn.exec(`ALTER TABLE intents ADD COLUMN confidence REAL NOT NULL DEFAULT 1.0`);
  if (!colNames.has('source_session_id')) conn.exec(`ALTER TABLE intents ADD COLUMN source_session_id TEXT`);
  if (!colNames.has('source_message_id')) conn.exec(`ALTER TABLE intents ADD COLUMN source_message_id TEXT`);
  if (!colNames.has('created_at')) conn.exec(`ALTER TABLE intents ADD COLUMN created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP`);
  if (!colNames.has('updated_at')) conn.exec(`ALTER TABLE intents ADD COLUMN updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP`);

  conn.exec(`
    CREATE INDEX IF NOT EXISTS idx_intents_status ON intents(status);
    CREATE INDEX IF NOT EXISTS idx_intents_updated_at ON intents(updated_at);
  `);
}

function parseArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      : [];
  } catch {
    return [];
  }
}

function normalizeLines(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean);
}

function formatRelative(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  const diff = Date.now() - date.getTime();
  const minute = 60 * 1000;
  const hour = 60 * minute;
  if (diff < minute) return '刚刚';
  if (diff < hour) return `${Math.max(1, Math.round(diff / minute))} 分钟前`;
  if (diff < 24 * hour) return `${Math.max(1, Math.round(diff / hour))} 小时前`;
  return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date);
}

function rowToIntent(row: IntentRow): IntentItem {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    why: row.why ?? undefined,
    similarSentences: parseArray(row.similar_sentences_json),
    relatedEntryCount: 0,
    recentHitCount: row.hit_count ?? 0,
    recentSnippets: row.last_hit_at ? [{ id: `${row.id}-last-hit`, excerpt: row.name, hitAt: formatRelative(row.last_hit_at) }] : [],
    updateStatus: row.status === 'archived' ? 'idle' : 'synced',
    updatedAt: formatRelative(row.updated_at),
  };
}

function rowToApiIntent(row: IntentRow) {
  return {
    ...rowToIntent(row),
    status: row.status === 'archived' ? 'archived' as const : 'active' as const,
    confidence: row.confidence ?? 1,
    sourceSessionId: row.source_session_id ?? undefined,
    sourceMessageId: row.source_message_id ?? undefined,
    createdAt: row.created_at,
    metadata: row.metadata_json ? (() => { try { return JSON.parse(row.metadata_json); } catch { return undefined; } })() : undefined,
  };
}

function legacyRowToIntent(row: LegacyIntentRow): IntentItem {
  return {
    id: row.id,
    name: row.title,
    description: row.content,
    why: row.summary ?? undefined,
    similarSentences: parseArray(row.similar_sentences),
    relatedEntryCount: 0,
    recentHitCount: 0,
    recentSnippets: row.last_hit_at ? [{ id: `${row.id}-last-hit`, excerpt: row.title, hitAt: formatRelative(row.last_hit_at) }] : [],
    updateStatus: row.status === 'active' ? 'synced' : 'idle',
    updatedAt: formatRelative(row.updated_at),
  };
}

function legacyRowToApiIntent(row: LegacyIntentRow) {
  return {
    ...legacyRowToIntent(row),
    status: row.status === 'active' ? 'active' as const : 'archived' as const,
    confidence: row.confidence ?? 1,
    sourceSessionId: undefined,
    sourceMessageId: undefined,
    createdAt: row.created_at,
    metadata: row.metadata_json ? (() => { try { return JSON.parse(row.metadata_json); } catch { return undefined; } })() : undefined,
  };
}

function getLegacyIntentRows(status: IntentStatus = 'active'): LegacyIntentRow[] {
  const dbConn = getDb();
  const table = dbConn.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='entries'").get() as { name: string } | undefined;
  if (!table) return [];
  return dbConn.prepare(`
    SELECT id, title, content, summary, similar_sentences, status, confidence, created_at, updated_at, last_hit_at, metadata_json
    FROM entries
    WHERE type = 'intent' AND status = ?
    ORDER BY updated_at DESC
    LIMIT 200
  `).all(status) as LegacyIntentRow[];
}

function getLegacyIntentRowById(id: string): LegacyIntentRow | undefined {
  const dbConn = getDb();
  const table = dbConn.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='entries'").get() as { name: string } | undefined;
  if (!table) return undefined;
  return dbConn.prepare(`
    SELECT id, title, content, summary, similar_sentences, status, confidence, created_at, updated_at, last_hit_at, metadata_json
    FROM entries
    WHERE id = ? AND type = 'intent'
  `).get(id) as LegacyIntentRow | undefined;
}

function mergeIntentItems(primary: IntentItem[], legacy: IntentItem[]): IntentItem[] {
  const merged = new Map<string, IntentItem>();
  for (const item of [...primary, ...legacy]) {
    if (!merged.has(item.id)) {
      merged.set(item.id, item);
    }
  }
  return [...merged.values()];
}

export function getIntentData(status: IntentStatus = 'active'): IntentData {
  const rows = getDb().prepare('SELECT * FROM intents WHERE status = ? ORDER BY updated_at DESC LIMIT 200').all(status) as IntentRow[];
  const items = mergeIntentItems(rows.map(rowToIntent), getLegacyIntentRows(status).map(legacyRowToIntent));
  return { items };
}

export function getIntentById(id: string) {
  const row = getDb().prepare('SELECT * FROM intents WHERE id = ?').get(id) as IntentRow | undefined;
  if (row) return rowToIntent(row);
  const legacyRow = getLegacyIntentRowById(id);
  return legacyRow ? legacyRowToIntent(legacyRow) : null;
}

export function getIntentApiById(id: string) {
  const row = getDb().prepare('SELECT * FROM intents WHERE id = ?').get(id) as IntentRow | undefined;
  if (row) return rowToApiIntent(row);
  const legacyRow = getLegacyIntentRowById(id);
  return legacyRow ? legacyRowToApiIntent(legacyRow) : null;
}

export async function upsertIntent(input: { id?: string; name: string; description: string; why?: string; similarSentences?: string[]; relatedEntryCount?: number; confidence?: number; sourceSessionId?: string; sourceMessageId?: string }) {
  const name = input.name.trim();
  const description = input.description.trim();
  const why = input.why?.trim() ?? '';
  const id = input.id?.trim() || `intent-${randomUUID()}`;
  const now = new Date().toISOString();
  const existing = getIntentApiById(id);
  const similarSentences = input.similarSentences ?? existing?.similarSentences ?? [];
  let embedding: Buffer | null = null;
  try {
    const vector = await embedQuery(`${name}\n${description}\n${why}\n${similarSentences.join('\n')}`);
    embedding = Buffer.from(new Float32Array(vector).buffer);
  } catch {
    embedding = null;
  }

  if (existing) {
    const intentExists = getDb().prepare('SELECT 1 FROM intents WHERE id = ?').get(id) as { 1: number } | undefined;
    if (intentExists) {
      getDb().prepare(`
        UPDATE intents
        SET name = ?, description = ?, why = ?, similar_sentences_json = ?, confidence = ?,
            source_session_id = ?, source_message_id = ?, embedding = COALESCE(?, embedding), updated_at = ?
        WHERE id = ?
      `).run(
        name,
        description,
        why || existing.why || null,
        JSON.stringify(similarSentences),
        input.confidence ?? existing.confidence,
        input.sourceSessionId ?? existing.sourceSessionId ?? null,
        input.sourceMessageId ?? existing.sourceMessageId ?? null,
        embedding,
        now,
        id,
      );
    } else {
      getDb().prepare(`
        UPDATE entries
        SET title = ?, content = ?, summary = ?, similar_sentences = ?, confidence = ?, updated_at = ?
        WHERE id = ? AND type = 'intent'
      `).run(
        name,
        description,
        why || existing.why || null,
        JSON.stringify(similarSentences),
        input.confidence ?? existing.confidence,
        now,
        id,
      );
    }
  } else {
    getDb().prepare(`
      INSERT INTO intents (id, name, description, why, similar_sentences_json, embedding, status, confidence, source_session_id, source_message_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)
    `).run(
      id,
      name,
      description,
      why || null,
      JSON.stringify(similarSentences),
      embedding,
      input.confidence ?? 1,
      input.sourceSessionId ?? null,
      input.sourceMessageId ?? null,
      now,
      now,
    );
  }
  return getIntentData();
}

export function deleteIntent(id: string) {
  const dbConn = getDb();
  const intentDelete = dbConn.prepare('DELETE FROM intents WHERE id = ?').run(id);
  const legacyDelete = dbConn.prepare("DELETE FROM entries WHERE id = ? AND type = 'intent'").run(id);
  return Number(intentDelete.changes ?? 0) + Number(legacyDelete.changes ?? 0) > 0 ? getIntentData() : null;
}

export async function searchIntents(query: string, limit = 10, minScore = 0.3) {
  const queryEmbedding = await embedQuery(query);
  const results = await semanticSearchIntents(queryEmbedding, limit, minScore);
  const ids = results.map((result) => result.id);
  if (ids.length === 0) return [];

  const placeholders = ids.map(() => '?').join(', ');
  const rows = getDb().prepare(`SELECT * FROM intents WHERE id IN (${placeholders})`).all(...ids) as IntentRow[];
  const rowMap = new Map(rows.map((row) => [row.id, row]));
  const now = new Date().toISOString();
  const updateHit = getDb().prepare('UPDATE intents SET hit_count = hit_count + 1, last_hit_at = ?, updated_at = ? WHERE id = ?');

  return results.flatMap((result) => {
    const row = rowMap.get(result.id);
    if (!row) return [];
    updateHit.run(now, now, result.id);
    return [{ ...rowToApiIntent(row), score: result.score }];
  });
}

export { normalizeLines as normalizeIntentLines };
