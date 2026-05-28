import type { IntentInput, IntentRecord, IntentSearchOptions, IntentSearchResult } from './intent-types.js';
import { createEmbeddingProvider } from '../embedding/create-provider.js';
import { randomUUID } from 'crypto';

interface DatabaseLike {
  prepare(sql: string): {
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): { changes?: number };
  };
  exec(sql: string): void;
}

interface IntentRow {
  id: string;
  name: string;
  description: string;
  positives_json: string | null;
  negatives_json: string | null;
  embedding: Buffer | string | null;
  status: string | null;
  hit_count: number | null;
  last_hit_at: string | null;
  confidence: number | null;
  source_session_id: string | null;
  source_message_id: string | null;
  created_at: string;
  updated_at: string;
}

export function ensureIntentSchema(db: DatabaseLike): void {
  db.exec(`
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

  const columns = db.prepare('PRAGMA table_info(intents)').all() as Array<{ name: string }>;
  const colNames = new Set(columns.map(c => c.name));
  if (!colNames.has('name')) db.exec(`ALTER TABLE intents ADD COLUMN name TEXT NOT NULL DEFAULT ''`);
  if (!colNames.has('description')) db.exec(`ALTER TABLE intents ADD COLUMN description TEXT NOT NULL DEFAULT ''`);
  if (!colNames.has('positives_json')) db.exec(`ALTER TABLE intents ADD COLUMN positives_json TEXT NOT NULL DEFAULT '[]'`);
  if (!colNames.has('negatives_json')) db.exec(`ALTER TABLE intents ADD COLUMN negatives_json TEXT NOT NULL DEFAULT '[]'`);
  if (!colNames.has('embedding')) db.exec(`ALTER TABLE intents ADD COLUMN embedding BLOB`);
  if (!colNames.has('status')) db.exec(`ALTER TABLE intents ADD COLUMN status TEXT NOT NULL DEFAULT 'active'`);
  if (!colNames.has('hit_count')) db.exec(`ALTER TABLE intents ADD COLUMN hit_count INTEGER NOT NULL DEFAULT 0`);
  if (!colNames.has('last_hit_at')) db.exec(`ALTER TABLE intents ADD COLUMN last_hit_at TEXT`);
  if (!colNames.has('confidence')) db.exec(`ALTER TABLE intents ADD COLUMN confidence REAL NOT NULL DEFAULT 1.0`);
  if (!colNames.has('source_session_id')) db.exec(`ALTER TABLE intents ADD COLUMN source_session_id TEXT`);
  if (!colNames.has('source_message_id')) db.exec(`ALTER TABLE intents ADD COLUMN source_message_id TEXT`);
  if (!colNames.has('created_at')) db.exec(`ALTER TABLE intents ADD COLUMN created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP`);
  if (!colNames.has('updated_at')) db.exec(`ALTER TABLE intents ADD COLUMN updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP`);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_intents_status ON intents(status);
    CREATE INDEX IF NOT EXISTS idx_intents_updated_at ON intents(updated_at);
    CREATE INDEX IF NOT EXISTS idx_intents_source_session ON intents(source_session_id);
  `);

  const entryColumns = db.prepare('PRAGMA table_info(entries)').all() as Array<{ name: string }>;
  if (entryColumns.some((column) => column.name === 'type')) {
    migrateIntentEntries(db);
  }
}

function migrateIntentEntries(db: DatabaseLike): void {
  db.exec(`
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

function safeJsonArray(raw: string | null | undefined): string[] {
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

export function encodeEmbedding(value: IntentInput['embedding']): Buffer | string | null {
  if (!value) return null;
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === 'string') return value;
  return Buffer.from(new Float32Array(value).buffer);
}

export function decodeEmbedding(raw: Buffer | string | null): ArrayLike<number> | null {
  if (!raw) return null;
  if (Buffer.isBuffer(raw)) {
    if (raw.byteLength === 0 || raw.byteLength % 4 !== 0) return null;
    return new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed) && parsed.every((value) => typeof value === 'number')) return parsed as number[];
  } catch {
    return null;
  }
  return null;
}

function cosineSimilarity(a: number[], b: ArrayLike<number>): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const av = a[i];
    const bv = b[i];
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

function rowToIntent(row: IntentRow): IntentRecord {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    positives: safeJsonArray(row.positives_json),
    negatives: safeJsonArray(row.negatives_json),
    status: row.status === 'archived' ? 'archived' : 'active',
    hitCount: row.hit_count ?? 0,
    lastHitAt: row.last_hit_at ? new Date(row.last_hit_at) : undefined,
    confidence: row.confidence ?? 1,
    sourceSessionId: row.source_session_id ?? undefined,
    sourceMessageId: row.source_message_id ?? undefined,
    embedding: row.embedding,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

function nowIso() {
  return new Date().toISOString();
}

export class IntentRepository {
  constructor(private readonly db: DatabaseLike) {
    ensureIntentSchema(db);
  }

  list(options?: { status?: 'active' | 'archived'; limit?: number }): IntentRecord[] {
    const conditions: string[] = [];
    const params: unknown[] = [];
    const status = options?.status ?? 'active';
    if (status) {
      conditions.push('status = ?');
      params.push(status);
    }
    const limit = Math.min(Math.max(options?.limit ?? 200, 1), 500);
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = this.db.prepare(`SELECT * FROM intents ${where} ORDER BY updated_at DESC LIMIT ?`).all(...params, limit) as IntentRow[];
    return rows.map(rowToIntent);
  }

  findById(id: string): IntentRecord | null {
    const row = this.db.prepare('SELECT * FROM intents WHERE id = ?').get(id) as IntentRow | undefined;
    return row ? rowToIntent(row) : null;
  }

  upsert(input: IntentInput): IntentRecord {
    const id = input.id?.trim() || `intent-${randomUUID()}`;
    const createdAt = nowIso();
    const existing = this.findById(id);
    const updatedAt = nowIso();
    const embedding = encodeEmbedding(input.embedding);

    if (existing) {
      this.db.prepare(`
        UPDATE intents
        SET name = ?, description = ?, positives_json = ?, negatives_json = ?, status = ?, confidence = ?,
            source_session_id = ?, source_message_id = ?, embedding = COALESCE(?, embedding), updated_at = ?
        WHERE id = ?
      `).run(
        input.name,
        input.description,
        JSON.stringify(input.positives ?? []),
        JSON.stringify(input.negatives ?? []),
        input.status ?? existing.status,
        input.confidence ?? existing.confidence,
        input.sourceSessionId ?? existing.sourceSessionId ?? null,
        input.sourceMessageId ?? existing.sourceMessageId ?? null,
        embedding,
        updatedAt,
        id,
      );
      return this.findById(id)!;
    }

    this.db.prepare(`
      INSERT INTO intents (id, name, description, positives_json, negatives_json, embedding, status, confidence, source_session_id, source_message_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.name,
      input.description,
      JSON.stringify(input.positives ?? []),
      JSON.stringify(input.negatives ?? []),
      embedding,
      input.status ?? 'active',
      input.confidence ?? 1,
      input.sourceSessionId ?? null,
      input.sourceMessageId ?? null,
      createdAt,
      updatedAt,
    );
    return this.findById(id)!;
  }

  delete(id: string): boolean {
    const result = this.db.prepare('DELETE FROM intents WHERE id = ?').run(id);
    return Number(result.changes ?? 0) > 0;
  }

  markHit(id: string, hitAt = nowIso()): void {
    this.db.prepare('UPDATE intents SET hit_count = hit_count + 1, last_hit_at = ?, updated_at = ? WHERE id = ?').run(hitAt, hitAt, id);
  }

  async search(query: string, options?: IntentSearchOptions): Promise<IntentSearchResult[]> {
    const sanitized = query.replace(/\s+/g, ' ').trim();
    if (!sanitized) return [];
    const limit = Math.min(Math.max(options?.limit ?? 10, 1), 100);
    const minScore = options?.minScore ?? 0.3;
    const status = options?.status ?? 'active';

    const rows = this.db.prepare(
      'SELECT * FROM intents WHERE status = ? AND embedding IS NOT NULL ORDER BY updated_at DESC LIMIT 1000',
    ).all(status) as IntentRow[];
    if (rows.length === 0) return [];

    const embedder = createEmbeddingProvider();
    const queryVector = await embedder.embed(sanitized);
    if (!queryVector || queryVector.length === 0) return [];

    const scored: IntentSearchResult[] = [];
    for (const row of rows) {
      const stored = decodeEmbedding(row.embedding);
      if (!stored) continue;
      const score = cosineSimilarity(queryVector, stored);
      if (score >= minScore) scored.push({ intent: rowToIntent(row), score });
    }

    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, limit);
    for (const result of top) this.markHit(result.intent.id);
    return top;
  }
}
