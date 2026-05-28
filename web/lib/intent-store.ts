import Database from 'better-sqlite3';
import path from 'path';
import { randomUUID } from 'crypto';
import type { IntentData, IntentItem } from './demo-dashboard-data';
import { embedQuery, semanticSearchIntents } from './semantic-search';

const DB_PATH = process.env.KIVO_DB_PATH || path.resolve(process.cwd(), '../kivo.db');

type IntentStatus = 'active' | 'archived';

interface IntentRow {
  id: string;
  name: string;
  description: string;
  positives_json: string | null;
  negatives_json: string | null;
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
      positives_json TEXT NOT NULL DEFAULT '[]',
      negatives_json TEXT NOT NULL DEFAULT '[]',
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
  if (!colNames.has('positives_json')) conn.exec(`ALTER TABLE intents ADD COLUMN positives_json TEXT NOT NULL DEFAULT '[]'`);
  if (!colNames.has('negatives_json')) conn.exec(`ALTER TABLE intents ADD COLUMN negatives_json TEXT NOT NULL DEFAULT '[]'`);
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

  const tables = conn.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='entries'").get() as { name: string } | undefined;
  if (!tables) return;

  conn.exec(`
    INSERT INTO intents (
      id, name, description, positives_json, negatives_json, embedding,
      status, hit_count, last_hit_at, confidence, source_session_id, source_message_id,
      created_at, updated_at
    )
    SELECT
      e.id,
      COALESCE(NULLIF(e.title, ''), substr(e.content, 1, 60)),
      COALESCE(NULLIF(e.summary, ''), e.content),
      COALESCE(e.similar_sentences, '[]'),
      '[]',
      e.embedding,
      CASE WHEN e.status = 'active' THEN 'active' ELSE 'archived' END,
      0,
      NULL,
      COALESCE(e.confidence, 1.0),
      json_extract(e.metadata_json, '$.domainData.realtimeCapture.sessionId'),
      json_extract(e.metadata_json, '$.domainData.realtimeCapture.messageId'),
      e.created_at,
      e.updated_at
    FROM entries e
    WHERE e.type = 'intent'
      AND NOT EXISTS (SELECT 1 FROM intents i WHERE i.id = e.id);

    UPDATE entries
    SET status = 'migrated_to_intents', updated_at = datetime('now')
    WHERE type = 'intent' AND status != 'migrated_to_intents';
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
    positives: parseArray(row.positives_json),
    negatives: parseArray(row.negatives_json),
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

export function getIntentData(status: IntentStatus = 'active'): IntentData {
  const rows = getDb().prepare('SELECT * FROM intents WHERE status = ? ORDER BY updated_at DESC LIMIT 200').all(status) as IntentRow[];
  return { items: rows.map(rowToIntent) };
}

export function getIntentById(id: string) {
  const row = getDb().prepare('SELECT * FROM intents WHERE id = ?').get(id) as IntentRow | undefined;
  return row ? rowToIntent(row) : null;
}

export function getIntentApiById(id: string) {
  const row = getDb().prepare('SELECT * FROM intents WHERE id = ?').get(id) as IntentRow | undefined;
  return row ? rowToApiIntent(row) : null;
}

export async function upsertIntent(input: { id?: string; name: string; description: string; positives?: string[]; negatives?: string[]; relatedEntryCount?: number; confidence?: number; sourceSessionId?: string; sourceMessageId?: string }) {
  const name = input.name.trim();
  const description = input.description.trim();
  const id = input.id?.trim() || `intent-${randomUUID()}`;
  const now = new Date().toISOString();
  const existing = getIntentApiById(id);
  const positives = input.positives ?? [];
  const negatives = input.negatives ?? [];
  let embedding: Buffer | null = null;
  try {
    const vector = await embedQuery(`${name}\n${description}\n${positives.join('\n')}`);
    embedding = Buffer.from(new Float32Array(vector).buffer);
  } catch {
    embedding = null;
  }

  if (existing) {
    getDb().prepare(`
      UPDATE intents
      SET name = ?, description = ?, positives_json = ?, negatives_json = ?, confidence = ?,
          source_session_id = ?, source_message_id = ?, embedding = COALESCE(?, embedding), updated_at = ?
      WHERE id = ?
    `).run(
      name,
      description,
      JSON.stringify(positives),
      JSON.stringify(negatives),
      input.confidence ?? existing.confidence,
      input.sourceSessionId ?? existing.sourceSessionId ?? null,
      input.sourceMessageId ?? existing.sourceMessageId ?? null,
      embedding,
      now,
      id,
    );
  } else {
    getDb().prepare(`
      INSERT INTO intents (id, name, description, positives_json, negatives_json, embedding, status, confidence, source_session_id, source_message_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)
    `).run(
      id,
      name,
      description,
      JSON.stringify(positives),
      JSON.stringify(negatives),
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
  const result = getDb().prepare('DELETE FROM intents WHERE id = ?').run(id);
  return Number(result.changes ?? 0) > 0 ? getIntentData() : null;
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
