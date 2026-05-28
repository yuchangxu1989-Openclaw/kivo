import fs from 'node:fs';
import Database from 'better-sqlite3';
import type { EmbeddingProvider } from '../embedding/embedding-provider.js';
import { LocalEmbedding } from '../embedding/local-embedding.js';
import type { KnowledgeEntry } from '../types/index.js';
import { RELATION_TYPES, isRelationType, type RelationType } from '../types/graph.js';

const OPENCLAW_CONFIG_PATH = '/root/.openclaw/openclaw.json';
const SUBJECT_GRAPH_PROVIDER_ID = 'penguin-main';
const SUBJECT_GRAPH_MODEL = 'claude-opus-4-7';
const DEFAULT_TOP_K = 8;
const MAX_LLM_CANDIDATES = 5;
const DEFAULT_CONFIDENCE = 0.7;
const EDGE_SOURCE = 'subject_llm';
const EDGE_VIEW = 'subject';

interface EntryRow {
  id: string;
  type: string;
  title: string;
  content: string;
  summary: string;
  source_json: string;
  tags_json: string;
  domain: string | null;
  subject_id: string | null;
  metadata_json: string | null;
  embedding: Buffer | null;
}

interface CandidateRelation {
  candidateId: string;
  relationType: RelationType;
  strength: number;
  confidence: number;
  rationale?: string;
}

interface QueueSubjectGraphWriteOptions {
  topK?: number;
  concurrency?: number;
}

interface RetrySubjectGraphWritesOptions extends QueueSubjectGraphWriteOptions {
  limit?: number;
}

interface RebuildDoneMaterialsOptions extends QueueSubjectGraphWriteOptions {
  materialLimit?: number;
}

interface PenguinProviderConfig {
  baseUrl: string;
  apiKey: string;
}

let cachedPenguinProvider: PenguinProviderConfig | null = null;

function ensureGraphSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS graph_nodes (
      entry_id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      domain TEXT,
      tags_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS graph_edges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id TEXT NOT NULL,
      target_id TEXT NOT NULL,
      association_type TEXT NOT NULL,
      edge_type TEXT,
      edge_source TEXT NOT NULL,
      weight REAL NOT NULL DEFAULT 0.5,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(source_id, target_id, edge_source)
    );

    CREATE INDEX IF NOT EXISTS idx_graph_edges_source ON graph_edges(source_id);
    CREATE INDEX IF NOT EXISTS idx_graph_edges_target ON graph_edges(target_id);
  `);

  const columns = db.prepare('PRAGMA table_info(graph_edges)').all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === 'edge_view')) {
    db.exec(`ALTER TABLE graph_edges ADD COLUMN edge_view TEXT DEFAULT '${EDGE_VIEW}'`);
  }
  if (!columns.some((column) => column.name === 'edge_type')) {
    db.exec('ALTER TABLE graph_edges ADD COLUMN edge_type TEXT');
  }
  db.exec(`UPDATE graph_edges SET edge_type = association_type WHERE edge_type IS NULL OR edge_type = ''`);
}

function clamp01(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(1, value));
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

function bufferToVector(buffer: Buffer): Float32Array {
  return new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);
}

function parseJsonObject(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function parseTags(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function extractMaterialId(sourceJson: string, metadataJson: string | null): string | null {
  const source = parseJsonObject(sourceJson);
  if (typeof source.materialId === 'string' && source.materialId.trim()) return source.materialId.trim();
  const metadata = parseJsonObject(metadataJson);
  const domainData = metadata.domainData;
  if (domainData && typeof domainData === 'object') {
    const sourceMaterialId = (domainData as Record<string, unknown>).sourceMaterialId;
    if (typeof sourceMaterialId === 'string' && sourceMaterialId.trim()) return sourceMaterialId.trim();
    const materialIds = (domainData as Record<string, unknown>).materialIds;
    if (Array.isArray(materialIds)) {
      const first = materialIds.find((item): item is string => typeof item === 'string' && item.trim().length > 0);
      if (first) return first.trim();
    }
  }
  return null;
}

function mergeGraphPendingMetadata(
  raw: string | null,
  pending: boolean,
  reason?: string,
): string {
  const metadata = parseJsonObject(raw);
  const domainData = metadata.domainData && typeof metadata.domainData === 'object'
    ? { ...(metadata.domainData as Record<string, unknown>) }
    : {};
  if (pending) {
    domainData.graphPending = true;
    domainData.graphPendingReason = reason ?? 'subject_graph_write_failed';
    domainData.graphPendingUpdatedAt = new Date().toISOString();
  } else {
    delete domainData.graphPending;
    delete domainData.graphPendingReason;
    delete domainData.graphPendingUpdatedAt;
  }
  metadata.domainData = domainData;
  return JSON.stringify(metadata);
}

function setGraphPending(db: Database.Database, entryId: string, pending: boolean, reason?: string): void {
  const row = db.prepare('SELECT metadata_json FROM entries WHERE id = ?').get(entryId) as { metadata_json: string | null } | undefined;
  if (!row) return;
  const next = mergeGraphPendingMetadata(row.metadata_json, pending, reason);
  db.prepare(`UPDATE entries SET metadata_json = ?, updated_at = datetime('now') WHERE id = ?`).run(next, entryId);
}

function getPenguinProvider(): PenguinProviderConfig {
  if (cachedPenguinProvider) return cachedPenguinProvider;
  const raw = fs.readFileSync(OPENCLAW_CONFIG_PATH, 'utf-8');
  const parsed = JSON.parse(raw) as {
    models?: { providers?: Record<string, { baseUrl?: string; apiKey?: string }> };
  };
  const provider = parsed.models?.providers?.[SUBJECT_GRAPH_PROVIDER_ID];
  if (!provider?.baseUrl || !provider.apiKey) {
    throw new Error(`Provider "${SUBJECT_GRAPH_PROVIDER_ID}" missing baseUrl/apiKey in ${OPENCLAW_CONFIG_PATH}`);
  }
  cachedPenguinProvider = {
    baseUrl: provider.baseUrl.replace(/\/$/, ''),
    apiKey: provider.apiKey,
  };
  return cachedPenguinProvider;
}

async function completeSubjectRelations(prompt: string): Promise<string> {
  const provider = getPenguinProvider();
  const response = await fetch(`${provider.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${provider.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: SUBJECT_GRAPH_MODEL,
      temperature: 0.1,
      max_tokens: 1200,
      messages: [
        {
          role: 'system',
          content:
            'You extract subject-knowledge graph relations. Return JSON only. Never use relation types outside the whitelist.',
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
    }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Subject graph LLM HTTP ${response.status}: ${text.slice(0, 400)}`);
  }
  const parsed = JSON.parse(text) as { choices?: Array<{ message?: { content?: string } }> };
  const content = parsed.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('Subject graph LLM returned empty content');
  }
  return content;
}

function extractJsonArray(raw: string): unknown[] {
  const trimmed = raw.trim();
  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenceMatch) {
      try {
        const parsed = JSON.parse(fenceMatch[1].trim());
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    }
    const start = trimmed.indexOf('[');
    const end = trimmed.lastIndexOf(']');
    if (start >= 0 && end > start) {
      try {
        const parsed = JSON.parse(trimmed.slice(start, end + 1));
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    }
    return [];
  }
}

function validateCandidateRelation(raw: unknown, candidateIds: Set<string>): CandidateRelation | null {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as Record<string, unknown>;
  const candidateId = typeof item.candidateId === 'string' ? item.candidateId : '';
  const relationType = item.relationType;
  if (!candidateIds.has(candidateId) || !isRelationType(relationType)) return null;
  return {
    candidateId,
    relationType,
    strength: clamp01(typeof item.strength === 'number' ? item.strength : Number(item.strength), 0.5),
    confidence: clamp01(typeof item.confidence === 'number' ? item.confidence : Number(item.confidence), DEFAULT_CONFIDENCE),
    rationale: typeof item.rationale === 'string' ? item.rationale.slice(0, 400) : undefined,
  };
}

function buildPrompt(entry: EntryRow, candidates: EntryRow[]): string {
  const whitelist = RELATION_TYPES.join(', ');
  const payload = {
    source: {
      id: entry.id,
      title: entry.title,
      type: entry.type,
      subjectId: entry.subject_id,
      summary: entry.summary,
      content: entry.content.slice(0, 2000),
    },
    candidates: candidates.map((candidate) => ({
      id: candidate.id,
      title: candidate.title,
      type: candidate.type,
      summary: candidate.summary,
      content: candidate.content.slice(0, 1400),
    })),
  };
  return [
    'Given one subject knowledge entry and up to five semantically similar candidate entries, decide which candidates have a meaningful graph relation to the source entry.',
    `Allowed relation types only: ${whitelist}.`,
    'Return a JSON array. Each item must be:',
    '{"candidateId":"...", "relationType":"...", "strength":0-1, "confidence":0-1, "rationale":"..."}',
    'Rules:',
    '- Only include candidates with a real subject relation.',
    '- If no candidate qualifies, return [].',
    '- Do not invent IDs.',
    '- confidence defaults to 0.7 if uncertain, but still emit a numeric value.',
    JSON.stringify(payload),
  ].join('\n');
}

function readEntry(db: Database.Database, entryId: string): EntryRow | null {
  const row = db.prepare(`
    SELECT id, type, title, content, summary, source_json, tags_json, domain, subject_id, metadata_json, embedding
    FROM entries
    WHERE id = ?
  `).get(entryId) as EntryRow | undefined;
  return row ?? null;
}

async function ensureEntryEmbedding(
  db: Database.Database,
  entry: EntryRow,
  embedder: EmbeddingProvider,
): Promise<Float32Array> {
  if (entry.embedding && entry.embedding.byteLength > 0) {
    return bufferToVector(entry.embedding);
  }
  const text = `${entry.title}\n${entry.summary}\n${entry.content}`;
  const vector = await embedder.embed(text);
  const blob = Buffer.from(new Float32Array(vector).buffer);
  db.prepare(`UPDATE entries SET embedding = ?, updated_at = datetime('now') WHERE id = ?`).run(blob, entry.id);
  entry.embedding = blob;
  return new Float32Array(vector);
}

async function findTopCandidates(
  db: Database.Database,
  entry: EntryRow,
  embedder: EmbeddingProvider,
  topK: number,
): Promise<EntryRow[]> {
  const sourceVector = await ensureEntryEmbedding(db, entry, embedder);
  const rows = db.prepare(`
    SELECT id, type, title, content, summary, source_json, tags_json, domain, subject_id, metadata_json, embedding
    FROM entries
    WHERE status = 'active'
      AND id != ?
      AND subject_id IS NOT NULL
      AND (${entry.subject_id ? 'subject_id = ?' : '1 = 1'})
  `).all(...(entry.subject_id ? [entry.id, entry.subject_id] : [entry.id])) as EntryRow[];

  const scored: Array<{ row: EntryRow; score: number }> = [];
  for (const row of rows) {
    const vector = await ensureEntryEmbedding(db, row, embedder);
    const score = cosineSimilarity(sourceVector, vector);
    if (score > 0) scored.push({ row, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK).map((item) => item.row);
}

function ensureGraphNode(db: Database.Database, entry: EntryRow): void {
  db.prepare(`
    INSERT INTO graph_nodes (entry_id, type, title, domain, tags_json, created_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(entry_id) DO UPDATE SET
      type = excluded.type,
      title = excluded.title,
      domain = excluded.domain,
      tags_json = excluded.tags_json
  `).run(entry.id, entry.type, entry.title, entry.domain, entry.tags_json || JSON.stringify(parseTags(entry.tags_json)));
}

function writeEdge(
  db: Database.Database,
  sourceId: string,
  targetId: string,
  relationType: RelationType,
  strength: number,
  confidence: number,
  rationale?: string,
): void {
  if (!isRelationType(relationType)) {
    throw new Error(`Rejected non-whitelist relation type: ${String(relationType)}`);
  }
  const metadata = JSON.stringify({ confidence, rationale });
  db.prepare(`
    INSERT INTO graph_edges (
      source_id, target_id, association_type, edge_type, edge_source, weight, created_at, edge_view
    ) VALUES (
      ?, ?, ?, ?, ?, ?, datetime('now'), ?
    )
    ON CONFLICT(source_id, target_id, edge_source) DO UPDATE SET
      association_type = excluded.association_type,
      edge_type = excluded.edge_type,
      weight = excluded.weight,
      created_at = excluded.created_at,
      edge_view = excluded.edge_view
  `).run(sourceId, targetId, relationType, relationType, EDGE_SOURCE, strength, EDGE_VIEW);
  db.prepare(`
    INSERT INTO kivo_meta (key, value, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(`subject-graph:last-edge:${sourceId}:${targetId}`, metadata);
}

async function processSingleEntry(
  db: Database.Database,
  entryId: string,
  embedder: EmbeddingProvider,
  topK: number,
): Promise<number> {
  const entry = readEntry(db, entryId);
  if (!entry || !entry.subject_id) return 0;
  ensureGraphNode(db, entry);
  const candidates = await findTopCandidates(db, entry, embedder, topK);
  const llmCandidates = candidates.slice(0, MAX_LLM_CANDIDATES);
  if (llmCandidates.length === 0) {
    setGraphPending(db, entry.id, false);
    return 0;
  }
  const prompt = buildPrompt(entry, llmCandidates);
  const content = await completeSubjectRelations(prompt);
  const candidateIds = new Set(llmCandidates.map((candidate) => candidate.id));
  const parsed = extractJsonArray(content);
  let written = 0;
  for (const item of parsed) {
    const relation = validateCandidateRelation(item, candidateIds);
    if (!relation) continue;
    const target = llmCandidates.find((candidate) => candidate.id === relation.candidateId);
    if (!target) continue;
    ensureGraphNode(db, target);
    writeEdge(
      db,
      entry.id,
      target.id,
      relation.relationType,
      relation.strength,
      relation.confidence,
      relation.rationale,
    );
    written += 1;
  }
  setGraphPending(db, entry.id, false);
  return written;
}

export async function queueSubjectGraphWriteForEntryIds(
  db: Database.Database,
  entryIds: string[],
  options: QueueSubjectGraphWriteOptions = {},
): Promise<{ processed: number; edgesWritten: number; failed: number }> {
  ensureGraphSchema(db);
  const topK = Math.max(1, options.topK ?? DEFAULT_TOP_K);
  const embedder = new LocalEmbedding();
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? 1));
  let processed = 0;
  let edgesWritten = 0;
  let failed = 0;

  const queue = [...new Set(entryIds)].filter(Boolean);
  let cursor = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (cursor < queue.length) {
      const entryId = queue[cursor];
      cursor += 1;
      const entry = readEntry(db, entryId);
      if (!entry?.subject_id) continue;
      try {
        edgesWritten += await processSingleEntry(db, entryId, embedder, topK);
        processed += 1;
      } catch (error) {
        failed += 1;
        setGraphPending(db, entryId, true, error instanceof Error ? error.message : String(error));
      }
    }
  });
  for (const worker of workers) {
    await worker;
  }
  return { processed, edgesWritten, failed };
}

export async function retryPendingSubjectGraphWrites(
  db: Database.Database,
  options: RetrySubjectGraphWritesOptions = {},
): Promise<{ processed: number; edgesWritten: number; failed: number }> {
  const rows = db.prepare(`
    SELECT id
    FROM entries
    WHERE status = 'active'
      AND subject_id IS NOT NULL
      AND json_extract(COALESCE(metadata_json, '{}'), '$.domainData.graphPending') = 1
    ORDER BY updated_at DESC
    LIMIT ?
  `).all(options.limit ?? 100) as Array<{ id: string }>;
  return queueSubjectGraphWriteForEntryIds(db, rows.map((row) => row.id), options);
}

export async function rebuildSubjectRelationsForDoneMaterials(
  db: Database.Database,
  options: RebuildDoneMaterialsOptions = {},
): Promise<{ materialIds: string[]; processed: number; edgesWritten: number; failed: number }> {
  const materialRows = db.prepare(`
    SELECT id
    FROM materials
    WHERE pipeline_status = 'done'
    ORDER BY created_at DESC
    LIMIT ?
  `).all(options.materialLimit ?? 4) as Array<{ id: string }>;
  const materialIds = materialRows.map((row) => row.id);
  if (materialIds.length === 0) {
    return { materialIds: [], processed: 0, edgesWritten: 0, failed: 0 };
  }
  const placeholders = materialIds.map(() => '?').join(', ');
  const entryRows = db.prepare(`
    SELECT id, source_json, metadata_json
    FROM entries
    WHERE status = 'active'
      AND subject_id IS NOT NULL
      AND (
        source_json LIKE '%' || ? || '%'
        ${materialIds.slice(1).map(() => ` OR source_json LIKE '%' || ? || '%'`).join('')}
      )
  `).all(...materialIds) as Array<{ id: string; source_json: string; metadata_json: string | null }>;

  const entryIds = entryRows
    .filter((row) => {
      const materialId = extractMaterialId(row.source_json, row.metadata_json);
      return materialId ? materialIds.includes(materialId) : false;
    })
    .map((row) => row.id);
  const result = await queueSubjectGraphWriteForEntryIds(db, entryIds, options);
  return { materialIds, ...result };
}
