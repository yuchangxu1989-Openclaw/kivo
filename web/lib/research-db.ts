import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { shouldBypassExternalModelsInTests } from '@kivo/utils/test-runtime';

import { openWebDb } from './db';
import { appendActivityEvent } from './domain-stores';
import { logResearchComplete } from './operation-log-integration';
import { writeOperationLog } from './operation-log-db';
import type { Priority, ResearchDashboardData, ResearchReferenceBatchStatus, ResearchStatus, ResearchTask } from './domain-types';
import type { KnowledgeEntry } from '@self-evolving-harness/kivo';
import { persistEntry } from './kivo-engine';
import { chatJson } from './llm/penguin-client';

const execFileAsync = promisify(execFile);
export type { Priority, ResearchDashboardData, ResearchReferenceBatchStatus, ResearchStatus, ResearchTask } from './domain-types';

const DEFAULT_EXPECTED_TYPES = ['fact', 'decision', 'methodology'];
const RESEARCH_AUTO_PAUSED_KEY = 'research:auto_paused';
const VALID_STATUSES = new Set(['pending', 'queued', 'executing', 'running', 'completed', 'failed', 'cancelled']);
const REGISTRY_STATUSES = new Set(['running', 'completed', 'failed', 'cancelled']);
const READABLE_REPORT_EXTENSIONS = new Set(['.md', '.markdown', '.txt']);
const EXTRACTION_PROMPT_VERSION = 'research-reference-v1';
const RESEARCH_TOPIC_REUSE_MIN_SCORE = 0.86;
const RESEARCH_EMBEDDING_ENDPOINT = process.env.KIVO_RESEARCH_EMBEDDING_URL || 'http://localhost:9876/api/v1/embeddings';
const RESEARCH_EMBEDDING_MODEL = process.env.KIVO_RESEARCH_EMBEDDING_MODEL || 'doubao-embedding-vision-251215';

type ResearchTaskRow = {
  id: string;
  query: string | null;
  requested_by: string | null;
  title: string | null;
  description: string | null;
  scope: string | null;
  priority: string | null;
  budget_credits: number | null;
  expected_types_json: string | null;
  status: string | null;
  created_at: number | string | null;
  updated_at: number | string | null;
  started_at: number | string | null;
  completed_at: number | string | null;
  adopted_at: number | string | null;
  highlighted: number | null;
  report_path: string | null;
  result_path: string | null;
  produced_entry_ids_json: string | null;
  failure_reason: string | null;
  wiki_page_id: string | null;
};

type ResearchTopicRow = {
  id: string;
  name: string;
  normalized_name: string;
  description: string | null;
  created_at: number | string | null;
  updated_at: number | string | null;
  task_count: number | null;
  report_count: number | null;
};

type ResearchReportRow = {
  id: string;
  topic_id: string;
  task_id: string | null;
  title: string;
  report_uri: string;
  report_kind: string | null;
  content_hash: string | null;
  external_content_hash: string | null;
  is_reference: number | null;
  reference_marked_at: number | string | null;
  reference_marked_by: string | null;
  created_at: number | string | null;
  updated_at: number | string | null;
  failure_reason: string | null;
  metadata_json: string | null;
};

type ReferenceBatchRow = {
  id: string;
  report_id: string;
  topic_id: string;
  content_hash: string | null;
  status: string;
  confirmed_by: string;
  confirmed_at: number | string | null;
  extracted_at: number | string | null;
  error_message: string | null;
  llm_provider_id: string | null;
  llm_model: string | null;
  extraction_prompt_version: string;
  extracted_summary: string | null;
  inserted_count: number | null;
  source_type: string | null;
  metadata_json: string | null;
};

type ResearchTaskRegistryRow = {
  id: string;
  topic_id: string | null;
  title: string | null;
  query: string | null;
  status: string | null;
  source_type: string | null;
  source_ref: string | null;
  actor_id: string | null;
  executor_id: string | null;
  created_at: number | string | null;
  updated_at: number | string | null;
  started_at: number | string | null;
  completed_at: number | string | null;
  cancelled_at: number | string | null;
  failure_reason: string | null;
  report_path: string | null;
  result_path: string | null;
  metadata_json: string | null;
};

export interface CreateResearchTaskInput {
  topic?: string;
  query?: string;
  scope?: string;
  priority: Priority;
  budgetCredits: number;
  expectedTypes: string[];
  requestedBy?: string;
  autoExecute?: boolean;
}

export interface RegisterResearchTaskInput {
  topicName: string;
  taskTitle: string;
  query?: string;
  sourceType?: string;
  sourceRef?: string;
  actorId?: string;
  executorId?: string;
  metadata?: Record<string, unknown>;
}

export interface RegisterResearchReportInput {
  taskId: string;
  title?: string;
  reportUri: string;
  reportKind?: string;
  externalContentHash?: string;
  metadata?: Record<string, unknown>;
}

export interface UpdateRegisteredResearchTaskStatusInput {
  taskId: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  reason?: string;
  reportUri?: string;
  reportTitle?: string;
  executorId?: string;
}

export interface ConfirmResearchReportInput {
  reportId: string;
  confirmedBy: string;
}

export interface ConfirmResearchReportResult {
  reportId: string;
  topicId: string;
  status: 'completed' | 'failed' | 'duplicate' | 'skipped';
  sourceType: 'local' | 'lark';
  contentHash?: string;
  batchId?: string;
  insertedCount: number;
  failureReason?: string;
}

export interface ResearchTaskDetailData extends ResearchTask {
  query: string;
  requestedBy: string;
  reportPath?: string;
  reportContent?: string;
  wikiPageId?: string;
}

function projectRoot() {
  return path.resolve(process.cwd(), '..');
}

function reportsDir() {
  return path.resolve(projectRoot(), 'reports');
}

function ensureResearchTables() {
  const db = openWebDb(false);
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS research_topics (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        normalized_name TEXT NOT NULL UNIQUE,
        description TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        task_count INTEGER NOT NULL DEFAULT 0,
        report_count INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS research_tasks (
        id TEXT PRIMARY KEY,
        topic_id TEXT,
        query TEXT,
        requested_by TEXT,
        title TEXT,
        description TEXT,
        scope TEXT,
        priority TEXT DEFAULT 'medium',
        budget_credits INTEGER DEFAULT 20,
        expected_types_json TEXT DEFAULT '["fact","decision","methodology"]',
        status TEXT,
        report_path TEXT,
        result_path TEXT,
        source_channel TEXT,
        source_type TEXT DEFAULT 'agent',
        source_ref TEXT,
        actor_id TEXT,
        executor_id TEXT,
        created_at INTEGER,
        updated_at INTEGER,
        started_at INTEGER,
        completed_at INTEGER,
        cancelled_at INTEGER,
        adopted_at INTEGER,
        highlighted INTEGER DEFAULT 0,
        failure_reason TEXT,
        wiki_page_id TEXT,
        metadata_json TEXT DEFAULT '{}',
        produced_entry_ids_json TEXT
      );

      CREATE TABLE IF NOT EXISTS research_reports (
        id TEXT PRIMARY KEY,
        topic_id TEXT NOT NULL,
        task_id TEXT,
        title TEXT NOT NULL,
        report_uri TEXT NOT NULL,
        report_kind TEXT NOT NULL DEFAULT 'markdown',
        content_hash TEXT,
        external_content_hash TEXT,
        is_reference INTEGER NOT NULL DEFAULT 0,
        reference_marked_at INTEGER,
        reference_marked_by TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        failure_reason TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        FOREIGN KEY (topic_id) REFERENCES research_topics(id) ON DELETE CASCADE,
        FOREIGN KEY (task_id) REFERENCES research_tasks(id) ON DELETE SET NULL
      );

      CREATE TABLE IF NOT EXISTS research_reference_batches (
        id TEXT PRIMARY KEY,
        report_id TEXT NOT NULL,
        topic_id TEXT NOT NULL,
        content_hash TEXT,
        status TEXT NOT NULL CHECK (status IN ('extracting', 'completed', 'failed', 'duplicate', 'skipped')),
        confirmed_by TEXT NOT NULL,
        confirmed_at INTEGER NOT NULL,
        extracted_at INTEGER,
        error_message TEXT,
        llm_provider_id TEXT,
        llm_model TEXT,
        extraction_prompt_version TEXT NOT NULL,
        extracted_summary TEXT,
        inserted_count INTEGER NOT NULL DEFAULT 0,
        source_type TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        FOREIGN KEY (report_id) REFERENCES research_reports(id) ON DELETE CASCADE,
        FOREIGN KEY (topic_id) REFERENCES research_topics(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS research_report_entries (
        id TEXT PRIMARY KEY,
        batch_id TEXT NOT NULL,
        report_id TEXT NOT NULL,
        topic_id TEXT NOT NULL,
        entry_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (batch_id) REFERENCES research_reference_batches(id) ON DELETE CASCADE,
        FOREIGN KEY (report_id) REFERENCES research_reports(id) ON DELETE CASCADE,
        FOREIGN KEY (topic_id) REFERENCES research_topics(id) ON DELETE CASCADE,
        FOREIGN KEY (entry_id) REFERENCES entries(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS kivo_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

    `);

    ensureColumn(db, 'research_tasks', 'query', 'TEXT');
    ensureColumn(db, 'research_tasks', 'topic_id', 'TEXT');
    ensureColumn(db, 'research_tasks', 'requested_by', 'TEXT');
    ensureColumn(db, 'research_tasks', 'title', 'TEXT');
    ensureColumn(db, 'research_tasks', 'description', 'TEXT');
    ensureColumn(db, 'research_tasks', 'scope', 'TEXT');
    ensureColumn(db, 'research_tasks', 'priority', "TEXT DEFAULT 'medium'");
    ensureColumn(db, 'research_tasks', 'budget_credits', 'INTEGER DEFAULT 20');
    ensureColumn(db, 'research_tasks', 'expected_types_json', `TEXT DEFAULT '${JSON.stringify(DEFAULT_EXPECTED_TYPES)}'`);
    ensureColumn(db, 'research_tasks', 'status', "TEXT DEFAULT 'pending'");
    ensureColumn(db, 'research_tasks', 'created_at', 'INTEGER');
    ensureColumn(db, 'research_tasks', 'updated_at', 'INTEGER');
    ensureColumn(db, 'research_tasks', 'started_at', 'INTEGER');
    ensureColumn(db, 'research_tasks', 'completed_at', 'INTEGER');
    ensureColumn(db, 'research_tasks', 'adopted_at', 'INTEGER');
    ensureColumn(db, 'research_tasks', 'highlighted', 'INTEGER DEFAULT 0');
    ensureColumn(db, 'research_tasks', 'report_path', 'TEXT');
    ensureColumn(db, 'research_tasks', 'result_path', 'TEXT');
    ensureColumn(db, 'research_tasks', 'produced_entry_ids_json', "TEXT DEFAULT '[]'");
    ensureColumn(db, 'research_tasks', 'failure_reason', 'TEXT');
    ensureColumn(db, 'research_tasks', 'wiki_page_id', 'TEXT');
    ensureColumn(db, 'research_tasks', 'source_type', "TEXT DEFAULT 'agent'");
    ensureColumn(db, 'research_tasks', 'source_ref', 'TEXT');
    ensureColumn(db, 'research_tasks', 'actor_id', 'TEXT');
    ensureColumn(db, 'research_tasks', 'executor_id', 'TEXT');
    ensureColumn(db, 'research_tasks', 'cancelled_at', 'INTEGER');
    ensureColumn(db, 'research_tasks', 'metadata_json', "TEXT DEFAULT '{}'");

    ensureColumn(db, 'research_reports', 'external_content_hash', 'TEXT');
    ensureColumn(db, 'research_reference_batches', 'inserted_count', 'INTEGER DEFAULT 0');
    ensureColumn(db, 'research_reference_batches', 'source_type', 'TEXT');
    ensureReferenceBatchStatusConstraint(db);

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_research_topics_updated_at
        ON research_topics(updated_at DESC);

      CREATE INDEX IF NOT EXISTS idx_research_tasks_topic_status
        ON research_tasks(topic_id, status, updated_at DESC);

      CREATE INDEX IF NOT EXISTS idx_research_tasks_updated_at
        ON research_tasks(updated_at DESC);

      CREATE UNIQUE INDEX IF NOT EXISTS idx_research_reports_uri
        ON research_reports(report_uri);

      CREATE INDEX IF NOT EXISTS idx_research_reports_topic_created
        ON research_reports(topic_id, created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_research_reports_reference
        ON research_reports(is_reference, reference_marked_at DESC);

      CREATE UNIQUE INDEX IF NOT EXISTS idx_research_reference_batches_dedup
        ON research_reference_batches(report_id, content_hash)
        WHERE status = 'completed';

      CREATE UNIQUE INDEX IF NOT EXISTS idx_research_reference_batches_claim
        ON research_reference_batches(report_id, content_hash)
        WHERE status IN ('extracting', 'completed');

      CREATE INDEX IF NOT EXISTS idx_research_reference_batches_report
        ON research_reference_batches(report_id, confirmed_at DESC);

      CREATE UNIQUE INDEX IF NOT EXISTS idx_research_report_entries_unique
        ON research_report_entries(report_id, entry_id);

      CREATE INDEX IF NOT EXISTS idx_research_report_entries_topic
        ON research_report_entries(topic_id, created_at DESC);
    `);

    db.prepare("UPDATE research_tasks SET query = COALESCE(query, title, description, '') WHERE query IS NULL OR query = ''").run();
    db.prepare("UPDATE research_tasks SET requested_by = COALESCE(requested_by, source_channel, 'unknown') WHERE requested_by IS NULL OR requested_by = ''").run();
    db.prepare("UPDATE research_tasks SET updated_at = COALESCE(updated_at, created_at, ?) WHERE updated_at IS NULL").run(Date.now());
    db.prepare("UPDATE research_tasks SET status = 'pending' WHERE status = 'queued'").run();
    db.prepare("UPDATE research_tasks SET status = 'executing' WHERE status = 'running'").run();
    backfillLegacyResearchRegistry(db);
  } finally {
    db.close();
  }
}

function ensureColumn(db: ReturnType<typeof openWebDb>, table: string, column: string, definition: string) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((item) => item.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function ensureReferenceBatchStatusConstraint(db: ReturnType<typeof openWebDb>): void {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'research_reference_batches'").get() as { sql?: string } | undefined;
  const sql = row?.sql ?? '';
  if (!sql.includes("status IN ('extracting', 'completed', 'failed')")) return;

  db.exec(`
    PRAGMA foreign_keys = OFF;
    ALTER TABLE research_reference_batches RENAME TO research_reference_batches_old;
    CREATE TABLE research_reference_batches (
      id TEXT PRIMARY KEY,
      report_id TEXT NOT NULL,
      topic_id TEXT NOT NULL,
      content_hash TEXT,
      status TEXT NOT NULL CHECK (status IN ('extracting', 'completed', 'failed', 'duplicate', 'skipped')),
      confirmed_by TEXT NOT NULL,
      confirmed_at INTEGER NOT NULL,
      extracted_at INTEGER,
      error_message TEXT,
      llm_provider_id TEXT,
      llm_model TEXT,
      extraction_prompt_version TEXT NOT NULL,
      extracted_summary TEXT,
      inserted_count INTEGER NOT NULL DEFAULT 0,
      source_type TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      FOREIGN KEY (report_id) REFERENCES research_reports(id) ON DELETE CASCADE,
      FOREIGN KEY (topic_id) REFERENCES research_topics(id) ON DELETE CASCADE
    );
    INSERT INTO research_reference_batches (
      id, report_id, topic_id, content_hash, status, confirmed_by, confirmed_at, extracted_at,
      error_message, llm_provider_id, llm_model, extraction_prompt_version, extracted_summary,
      inserted_count, source_type, metadata_json
    )
    SELECT
      id, report_id, topic_id, content_hash, status, confirmed_by, confirmed_at, extracted_at,
      error_message, llm_provider_id, llm_model, extraction_prompt_version, extracted_summary,
      COALESCE(inserted_count, 0), source_type, COALESCE(metadata_json, '{}')
    FROM research_reference_batches_old;
    DROP TABLE research_reference_batches_old;
    PRAGMA foreign_keys = ON;
  `);
}

function normalizeTopicName(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

function jsonObject(value: Record<string, unknown> | undefined): string {
  return JSON.stringify(value ?? {});
}

function parseJsonObject(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function workspaceRoot(): string {
  return path.resolve(process.env.KIVO_WORKSPACE_ROOT || '/root/.openclaw/workspace');
}

function normalizeReportContent(content: string): string {
  return content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
}

function calculateContentHash(content: string): string {
  return createHash('sha256').update(normalizeReportContent(content), 'utf8').digest('hex');
}

function sourceTypeFromReportUri(reportUri: string): 'local' | 'lark' {
  if (/^https?:\/\/(?:[^/]+\.)?(?:feishu|larksuite)\.(?:cn|com)\//i.test(reportUri) || /^lark:|^feishu:/i.test(reportUri)) {
    return 'lark';
  }
  return 'local';
}

function larkDocToken(reportUri: string): string {
  const trimmed = reportUri.trim();
  const customScheme = trimmed.match(/^(?:lark|feishu):\/\/(?:docx?|docs|wiki)\/([A-Za-z0-9_-]+)/i);
  if (customScheme?.[1]) return customScheme[1];
  const prefixedToken = trimmed.match(/^(?:lark|feishu):([A-Za-z0-9_-]+)$/i);
  if (prefixedToken?.[1]) return prefixedToken[1];
  const urlToken = trimmed.match(/\/(?:docx?|docs|wiki)\/([A-Za-z0-9_-]+)/i);
  if (urlToken?.[1]) return urlToken[1];
  if (/^[A-Za-z0-9_-]+$/.test(trimmed)) return trimmed;
  throw new Error(`Cannot extract Lark doc token from report URI: ${reportUri}`);
}

function extractLarkCliContent(stdout: string): string {
  const text = stdout.trim();
  if (!text) return '';
  try {
    const parsed = JSON.parse(text) as { data?: { markdown?: string; content?: string }; markdown?: string; content?: string };
    return parsed.data?.markdown ?? parsed.data?.content ?? parsed.markdown ?? parsed.content ?? text;
  } catch {
    return text;
  }
}

async function readLarkReport(reportUri: string): Promise<string> {
  const docToken = larkDocToken(reportUri);
  try {
    const { stdout } = await execFileAsync('lark-cli', ['docs', '+fetch', '--doc', docToken, '--as', 'bot'], {
      maxBuffer: 16 * 1024 * 1024,
    });
    const content = extractLarkCliContent(stdout);
    if (!content.trim()) throw new Error('Lark report returned empty content');
    return content;
  } catch (err) {
    if (err instanceof Error && err.message === 'Lark report returned empty content') throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Lark report reading failed via lark-cli: ${message}`);
  }
}

function resolveWorkspaceReportPath(reportUri: string): string {
  const root = workspaceRoot();
  const resolved = path.isAbsolute(reportUri) ? path.resolve(reportUri) : path.resolve(root, reportUri);
  const lexicalRelative = path.relative(root, resolved);
  if (lexicalRelative.startsWith('..') || path.isAbsolute(lexicalRelative)) {
    throw new Error(`Local report path escapes workspace: ${reportUri}`);
  }
  const ext = path.extname(resolved).toLowerCase();
  if (!READABLE_REPORT_EXTENSIONS.has(ext)) {
    throw new Error(`Local report type is not readable: ${ext || 'unknown'}`);
  }
  if (!fs.existsSync(resolved)) {
    throw new Error(`Local report does not exist: ${reportUri}`);
  }
  const realRoot = fs.realpathSync(root);
  const realResolved = fs.realpathSync(resolved);
  const realRelative = path.relative(realRoot, realResolved);
  if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) {
    throw new Error(`Local report path escapes workspace: ${reportUri}`);
  }
  return realResolved;
}

async function readFullReport(reportUri: string): Promise<{ content: string; sourceType: 'local' | 'lark' }> {
  const sourceType = sourceTypeFromReportUri(reportUri);
  if (sourceType === 'local') {
    const content = fs.readFileSync(resolveWorkspaceReportPath(reportUri), 'utf8');
    if (!content.trim()) throw new Error('Local report is empty');
    return { content, sourceType };
  }

  return { content: await readLarkReport(reportUri), sourceType };
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const av = a[i];
    const bv = b[i];
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  return normA === 0 || normB === 0 ? 0 : dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

async function embedResearchTopicName(name: string): Promise<number[]> {
  const response = await fetch(RESEARCH_EMBEDDING_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: name, model: RESEARCH_EMBEDDING_MODEL }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Research topic embedding HTTP ${response.status}: ${body.slice(0, 200)}`);
  }
  const data = await response.json() as { data?: Array<{ embedding?: number[] }> };
  const embedding = data.data?.[0]?.embedding;
  if (!Array.isArray(embedding) || embedding.length === 0) throw new Error('Research topic embedding response missing embedding');
  return embedding;
}

async function findSemanticResearchTopic(db: ReturnType<typeof openWebDb>, name: string): Promise<ResearchTopicRow | null> {
  const candidates = db.prepare('SELECT * FROM research_topics ORDER BY updated_at DESC').all() as ResearchTopicRow[];
  if (candidates.length === 0) return null;
  if (shouldBypassExternalModelsInTests()) return null;

  const target = await embedResearchTopicName(name);
  let best: { topic: ResearchTopicRow; score: number } | null = null;
  for (const topic of candidates) {
    const existing = await embedResearchTopicName(topic.name);
    const score = cosineSimilarity(target, existing);
    if (!best || score > best.score) best = { topic, score };
  }
  return best && best.score >= RESEARCH_TOPIC_REUSE_MIN_SCORE ? best.topic : null;
}

function updateTopicReuse(db: ReturnType<typeof openWebDb>, topic: ResearchTopicRow, description?: string): ResearchTopicRow {
  db.prepare('UPDATE research_topics SET updated_at = ?, description = COALESCE(description, ?) WHERE id = ?').run(Date.now(), description ?? null, topic.id);
  return db.prepare('SELECT * FROM research_topics WHERE id = ?').get(topic.id) as ResearchTopicRow;
}

function refreshResearchTopicCounters(db: ReturnType<typeof openWebDb>, topicId: string): void {
  const taskCount = (db.prepare('SELECT COUNT(*) AS count FROM research_tasks WHERE topic_id = ?').get(topicId) as { count: number }).count;
  const reportCount = (db.prepare('SELECT COUNT(*) AS count FROM research_reports WHERE topic_id = ?').get(topicId) as { count: number }).count;
  db.prepare('UPDATE research_topics SET task_count = ?, report_count = ?, updated_at = ? WHERE id = ?').run(taskCount, reportCount, Date.now(), topicId);
}

function insertResearchTopic(db: ReturnType<typeof openWebDb>, name: string, normalized: string, description?: string): ResearchTopicRow {
  const now = Date.now();
  const id = `topic_${randomUUID()}`;
  db.prepare(`
    INSERT INTO research_topics (id, name, normalized_name, description, created_at, updated_at, task_count, report_count)
    VALUES (?, ?, ?, ?, ?, ?, 0, 0)
  `).run(id, name, normalized, description ?? null, now, now);
  return db.prepare('SELECT * FROM research_topics WHERE id = ?').get(id) as ResearchTopicRow;
}

function ensureTopicInDb(db: ReturnType<typeof openWebDb>, topicName: string, description?: string): ResearchTopicRow {
  const name = topicName.trim();
  if (!name) throw new Error('topicName is required');
  const normalized = normalizeTopicName(name);
  const existing = db.prepare('SELECT * FROM research_topics WHERE normalized_name = ?').get(normalized) as ResearchTopicRow | undefined;
  return existing ? updateTopicReuse(db, existing, description) : insertResearchTopic(db, name, normalized, description);
}

async function ensureTopicInDbSemantic(db: ReturnType<typeof openWebDb>, topicName: string, description?: string): Promise<ResearchTopicRow> {
  const name = topicName.trim();
  if (!name) throw new Error('topicName is required');
  const normalized = normalizeTopicName(name);
  const existing = db.prepare('SELECT * FROM research_topics WHERE normalized_name = ?').get(normalized) as ResearchTopicRow | undefined;
  if (existing) return updateTopicReuse(db, existing, description);
  const semantic = await findSemanticResearchTopic(db, name);
  return semantic ? updateTopicReuse(db, semantic, description) : insertResearchTopic(db, name, normalized, description);
}

function backfillLegacyResearchRegistry(db: ReturnType<typeof openWebDb>) {
  const rows = db.prepare(`
    SELECT id, topic_id, title, query, description, scope, report_path, result_path
    FROM research_tasks
    WHERE topic_id IS NULL OR topic_id = ''
  `).all() as Array<{
    id: string;
    topic_id: string | null;
    title: string | null;
    query: string | null;
    description: string | null;
    scope: string | null;
    report_path: string | null;
    result_path: string | null;
  }>;
  for (const row of rows) {
    const topicName = (row.title ?? row.query ?? row.description ?? row.scope ?? '未命名调研').trim() || '未命名调研';
    const topic = ensureTopicInDb(db, topicName);
    db.prepare("UPDATE research_tasks SET topic_id = ?, source_type = COALESCE(source_type, 'legacy'), actor_id = COALESCE(actor_id, requested_by), metadata_json = COALESCE(metadata_json, '{}') WHERE id = ?").run(topic.id, row.id);
    const reportUri = row.result_path ?? row.report_path;
    if (reportUri) {
      db.prepare(`
        INSERT INTO research_reports (
          id, topic_id, task_id, title, report_uri, report_kind, created_at, updated_at, metadata_json
        ) VALUES (?, ?, ?, ?, ?, 'markdown', ?, ?, ?)
        ON CONFLICT(report_uri) DO UPDATE SET
          topic_id = excluded.topic_id,
          task_id = COALESCE(research_reports.task_id, excluded.task_id),
          updated_at = excluded.updated_at
      `).run(`report_${randomUUID()}`, topic.id, row.id, topicName, reportUri, Date.now(), Date.now(), jsonObject({ source: 'legacy-task' }));
    }
    refreshResearchTopicCounters(db, topic.id);
  }
}

function parseTimestamp(value: number | string | null | undefined): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const asNumber = Number(value);
    if (Number.isFinite(asNumber)) return asNumber;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function formatRelative(timestamp: number | null): string {
  if (!timestamp) return '刚刚';
  const diff = Date.now() - timestamp;
  const minute = 60 * 1000;
  const hour = 60 * minute;
  if (diff < minute) return '刚刚';
  if (diff < hour) return `${Math.max(1, Math.round(diff / minute))} 分钟前`;
  if (diff < 24 * hour) return `${Math.max(1, Math.round(diff / hour))} 小时前`;
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(timestamp));
}

function parseExpectedTypes(value: string | null): string[] {
  if (!value) return DEFAULT_EXPECTED_TYPES;
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : DEFAULT_EXPECTED_TYPES;
  } catch {
    return DEFAULT_EXPECTED_TYPES;
  }
}

function parseEntryIds(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : [];
  } catch {
    return [];
  }
}

function normalizeStatus(value: string | null): ResearchStatus {
  if (value === 'executing' || value === 'running') return 'running';
  if (value === 'completed' || value === 'failed' || value === 'cancelled') return value;
  return 'queued';
}

function dbStatusForUi(value: string | null): string {
  if (value === 'queued') return 'pending';
  if (value === 'running') return 'executing';
  if (value && VALID_STATUSES.has(value)) return value;
  return 'pending';
}

function inferBudgetCredits(priority: Priority) {
  if (priority === 'urgent') return 48;
  if (priority === 'high') return 36;
  if (priority === 'medium') return 20;
  return 12;
}

function safeJsonArray(values: string[]): string {
  return JSON.stringify(values.filter((item) => item.trim().length > 0));
}

function slugify(value: string): string {
  const ascii = value.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  return ascii || 'research';
}

function reportAbsolutePath(reportPath: string | null | undefined): string | null {
  if (!reportPath) return null;
  return path.isAbsolute(reportPath) ? reportPath : path.resolve(projectRoot(), reportPath);
}

function reportRelativePath(filePath: string): string {
  return path.relative(projectRoot(), filePath);
}

function readReport(reportPath: string | null | undefined): string | undefined {
  const abs = reportAbsolutePath(reportPath);
  if (!abs || !fs.existsSync(abs)) return undefined;
  return fs.readFileSync(abs, 'utf8');
}

function mapResearchRow(row: ResearchTaskRow): ResearchTask {
  const createdAt = parseTimestamp(row.created_at);
  const completedAt = parseTimestamp(row.completed_at);
  const resultEntryIds = parseEntryIds(row.produced_entry_ids_json);
  const resultPath = row.result_path ?? row.report_path ?? undefined;
  const title = (row.title ?? row.query ?? row.description ?? '').trim();
  const scope = (row.scope ?? '').trim();
  const priority = (row.priority as Priority | null) ?? 'medium';
  const reportContent = row.status === 'completed' ? readReport(resultPath) : undefined;

  return {
    id: row.id,
    topic: title || '未命名调研',
    scope: scope || '待补充范围',
    priority,
    budgetCredits: row.budget_credits ?? inferBudgetCredits(priority),
    expectedTypes: parseExpectedTypes(row.expected_types_json),
    status: normalizeStatus(row.status),
    createdAt: formatRelative(createdAt),
    adopted: parseTimestamp(row.adopted_at) !== null,
    highlighted: Boolean(row.highlighted),
    resultEntryIds,
    knowledgeCount: resultEntryIds.length,
    resultSummary: reportContent ? summarizeReport(reportContent, resultPath) : (completedAt && resultPath ? `报告已生成：${resultPath}` : undefined),
    failureReason: row.failure_reason ?? undefined,
  };
}

function summarizeReport(content: string, resultPath?: string): string {
  const firstUseful = content
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith('#') && !line.startsWith('OpenClaw'));
  const prefix = firstUseful ? firstUseful.slice(0, 180) : '报告已生成';
  return resultPath ? `${prefix}（${resultPath}）` : prefix;
}

function getAutoResearchPaused() {
  ensureResearchTables();
  const db = openWebDb(true);
  try {
    const row = db.prepare('SELECT value FROM kivo_meta WHERE key = ?').get(RESEARCH_AUTO_PAUSED_KEY) as { value: string } | undefined;
    return row?.value === 'true';
  } finally {
    db.close();
  }
}

function setAutoResearchPausedValue(paused: boolean) {
  ensureResearchTables();
  const db = openWebDb(false);
  try {
    db.prepare(`
      INSERT INTO kivo_meta (key, value, updated_at)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(RESEARCH_AUTO_PAUSED_KEY, paused ? 'true' : 'false');
  } finally {
    db.close();
  }
}

function selectResearchRows(): ResearchTaskRow[] {
  const db = openWebDb(true);
  try {
    return db.prepare(`
      SELECT
        id, query, requested_by, title, description, scope, priority, budget_credits, expected_types_json,
        status, created_at, updated_at, started_at, completed_at, adopted_at, highlighted,
        report_path, result_path, produced_entry_ids_json, failure_reason, wiki_page_id
      FROM research_tasks
      ORDER BY COALESCE(created_at, 0) DESC, id DESC
    `).all() as ResearchTaskRow[];
  } finally {
    db.close();
  }
}

function selectResearchTopics(): ResearchDashboardData['topics'] {
  const db = openWebDb(true);
  try {
    const topics = db.prepare('SELECT * FROM research_topics ORDER BY updated_at DESC, created_at DESC').all() as ResearchTopicRow[];
    const tasks = db.prepare(`
      SELECT id, topic_id, title, query, status, source_type, source_ref, actor_id, executor_id,
             created_at, updated_at, started_at, completed_at, cancelled_at, failure_reason,
             report_path, result_path, metadata_json
      FROM research_tasks
      WHERE topic_id IS NOT NULL AND topic_id != ''
      ORDER BY COALESCE(created_at, 0) DESC, id DESC
    `).all() as ResearchTaskRegistryRow[];
    const reports = db.prepare('SELECT * FROM research_reports ORDER BY created_at DESC, id DESC').all() as ResearchReportRow[];
    const batches = db.prepare('SELECT * FROM research_reference_batches ORDER BY confirmed_at DESC, id DESC').all() as ReferenceBatchRow[];
    const hasEntriesTable = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'entries'").get());
    const entryRows = (hasEntriesTable
      ? db.prepare(`
          SELECT r.report_id, r.entry_id, e.title
          FROM research_report_entries r
          LEFT JOIN entries e ON e.id = r.entry_id
          ORDER BY r.created_at ASC
        `)
      : db.prepare(`
          SELECT report_id, entry_id, NULL AS title
          FROM research_report_entries
          ORDER BY created_at ASC
        `)
    ).all() as Array<{ report_id: string; entry_id: string; title: string | null }>;

    const tasksByTopic = new Map<string, ResearchTaskRegistryRow[]>();
    for (const task of tasks) {
      if (!task.topic_id) continue;
      const list = tasksByTopic.get(task.topic_id) ?? [];
      list.push(task);
      tasksByTopic.set(task.topic_id, list);
    }

    const reportsByTask = new Map<string, ResearchReportRow[]>();
    const reportsByTopicWithoutTask = new Map<string, ResearchReportRow[]>();
    for (const report of reports) {
      if (report.task_id) {
        const list = reportsByTask.get(report.task_id) ?? [];
        list.push(report);
        reportsByTask.set(report.task_id, list);
      } else {
        const list = reportsByTopicWithoutTask.get(report.topic_id) ?? [];
        list.push(report);
        reportsByTopicWithoutTask.set(report.topic_id, list);
      }
    }

    const batchesByReport = new Map<string, ReferenceBatchRow[]>();
    for (const batch of batches) {
      const list = batchesByReport.get(batch.report_id) ?? [];
      list.push(batch);
      batchesByReport.set(batch.report_id, list);
    }

    const entriesByReport = new Map<string, Array<{ id: string; title?: string }>>();
    for (const entry of entryRows) {
      const list = entriesByReport.get(entry.report_id) ?? [];
      list.push({ id: entry.entry_id, title: entry.title ?? undefined });
      entriesByReport.set(entry.report_id, list);
    }

    const mapBatch = (batch: ReferenceBatchRow) => {
      const metadata = parseJsonObject(batch.metadata_json);
      return {
        id: batch.id,
        status: batch.status as ResearchReferenceBatchStatus,
        sourceType: batch.source_type ?? undefined,
        contentHash: batch.content_hash ?? undefined,
        confirmedBy: batch.confirmed_by,
        confirmedAt: batch.confirmed_at,
        extractedAt: batch.extracted_at,
        failureReason: batch.error_message,
        insertedCount: batch.inserted_count ?? 0,
        duplicateOfBatchId: typeof metadata.duplicateOfBatchId === 'string' ? metadata.duplicateOfBatchId : undefined,
      };
    };

    const mapReport = (report: ResearchReportRow) => {
      const reportBatches = (batchesByReport.get(report.id) ?? []).map(mapBatch);
      const latestBatch = reportBatches[0];
      const wikiEntries = entriesByReport.get(report.id) ?? [];
      return {
        id: report.id,
        title: report.title,
        reportUri: report.report_uri,
        reportKind: report.report_kind ?? undefined,
        contentHash: report.content_hash ?? undefined,
        externalContentHash: report.external_content_hash ?? undefined,
        isReference: Boolean(report.is_reference),
        referenceMarkedAt: report.reference_marked_at,
        referenceMarkedBy: report.reference_marked_by,
        sourceType: latestBatch?.sourceType ?? sourceTypeFromReportUri(report.report_uri),
        failureReason: report.failure_reason,
        batchStatus: latestBatch?.status,
        insertedCount: latestBatch?.insertedCount,
        wikiEntryCount: wikiEntries.length,
        wikiEntries,
        entryIds: wikiEntries.map((entry) => entry.id),
        referenceBatches: reportBatches,
      };
    };

    return topics.map((topic) => {
      const topicTasks = (tasksByTopic.get(topic.id) ?? []).map((task) => ({
        id: task.id,
        title: (task.title ?? task.query ?? '未命名调研任务').trim() || '未命名调研任务',
        query: task.query,
        status: normalizeStatus(task.status),
        sourceType: task.source_type,
        sourceRef: task.source_ref,
        actorId: task.actor_id,
        executorId: task.executor_id,
        createdAt: task.created_at,
        updatedAt: task.updated_at,
        startedAt: task.started_at,
        completedAt: task.completed_at,
        cancelledAt: task.cancelled_at,
        failureReason: task.failure_reason,
        reportPath: task.report_path,
        resultPath: task.result_path,
        reports: (reportsByTask.get(task.id) ?? []).map(mapReport),
      }));
      const orphanReports = reportsByTopicWithoutTask.get(topic.id) ?? [];
      if (orphanReports.length > 0) {
        topicTasks.push({
          id: `${topic.id}:reports`,
          title: '未关联任务报告',
          query: null,
          status: 'completed',
          sourceType: 'registry',
          sourceRef: null,
          actorId: null,
          executorId: null,
          createdAt: topic.created_at,
          updatedAt: topic.updated_at,
          startedAt: null,
          completedAt: null,
          cancelledAt: null,
          failureReason: null,
          reportPath: null,
          resultPath: null,
          reports: orphanReports.map(mapReport),
        });
      }
      const flatReports = topicTasks.flatMap((task) => task.reports);
      return {
        id: topic.id,
        name: topic.name,
        normalizedName: topic.normalized_name,
        description: topic.description,
        createdAt: topic.created_at,
        updatedAt: topic.updated_at,
        taskCount: topic.task_count ?? topicTasks.length,
        reportCount: topic.report_count ?? flatReports.length,
        referenceReportCount: flatReports.filter((report) => report.isReference).length,
        wikiEntryCount: flatReports.reduce((sum, report) => sum + report.wikiEntryCount, 0),
        tasks: topicTasks,
      };
    });
  } finally {
    db.close();
  }
}

export function getResearchDashboardData(): ResearchDashboardData {
  ensureResearchTables();
  return {
    autoResearchPaused: getAutoResearchPaused(),
    tasks: selectResearchRows().map(mapResearchRow),
    topics: selectResearchTopics(),
  };
}

export function getResearchTaskDetail(id: string): ResearchTaskDetailData | null {
  ensureResearchTables();
  const db = openWebDb(true);
  try {
    const row = db.prepare(`
      SELECT
        id, query, requested_by, title, description, scope, priority, budget_credits, expected_types_json,
        status, created_at, updated_at, started_at, completed_at, adopted_at, highlighted,
        report_path, result_path, produced_entry_ids_json, failure_reason, wiki_page_id
      FROM research_tasks
      WHERE id = ?
    `).get(id) as ResearchTaskRow | undefined;
    if (!row) return null;
    return {
      ...mapResearchRow(row),
      query: row.query ?? row.title ?? row.description ?? '',
      requestedBy: row.requested_by ?? 'unknown',
      reportPath: row.report_path ?? row.result_path ?? undefined,
      reportContent: readReport(row.report_path ?? row.result_path),
      wikiPageId: row.wiki_page_id ?? undefined,
    };
  } finally {
    db.close();
  }
}

export async function createResearchTask(input: CreateResearchTaskInput): Promise<ResearchDashboardData> {
  ensureResearchTables();
  const id = randomUUID();
  const now = Date.now();
  const query = (input.query ?? input.topic ?? '').trim();
  const scope = (input.scope ?? query).trim();
  const requestedBy = (input.requestedBy ?? 'unknown').trim() || 'unknown';

  const db = openWebDb(false);
  try {
    const topic = await ensureTopicInDbSemantic(db, input.topic ?? query);
    db.prepare(`
      INSERT INTO research_tasks (
        id, topic_id, query, requested_by, title, description, scope, priority, budget_credits, expected_types_json,
        status, source_type, actor_id, created_at, updated_at, highlighted, report_path, result_path, produced_entry_ids_json, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'web', ?, ?, ?, 0, NULL, NULL, '[]', '{}')
    `).run(
      id,
      topic.id,
      query,
      requestedBy,
      query,
      query,
      scope,
      input.priority,
      input.budgetCredits,
      JSON.stringify(input.expectedTypes),
      requestedBy,
      now,
      now,
    );
    refreshResearchTopicCounters(db, topic.id);
  } finally {
    db.close();
  }

  appendActivityEvent({ type: 'research_created', label: '新调研任务', summary: `已创建调研任务「${query}」,等待进入队列。`, href: '/research', tags: ['research', 'pending'] });

  if (input.autoExecute !== false) {
    void executeResearchTask(id);
  }

  return getResearchDashboardData();
}

export async function executeResearchTask(id: string): Promise<void> {
  const task = getResearchTaskDetail(id);
  if (!task) return;
  setResearchTaskStatus(id, 'executing');

  try {
    const report = await generateResearchReport(task);
    const absPath = path.resolve(reportsDir(), `research-${id}-${slugify(task.query)}.md`);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, report, 'utf8');
    const relativePath = reportRelativePath(absPath);
    completeResearchTask(id, relativePath);
    logResearchComplete(task.topic, relativePath);
  } catch (err) {
    failResearchTask(id, err instanceof Error ? err.message : String(err));
  }
}

function setResearchTaskStatus(id: string, status: 'pending' | 'executing') {
  const now = Date.now();
  const db = openWebDb(false);
  try {
    db.prepare(`
      UPDATE research_tasks
      SET status = ?, updated_at = ?, started_at = CASE WHEN ? = 'executing' THEN COALESCE(started_at, ?) ELSE started_at END
      WHERE id = ?
    `).run(status, now, status, now, id);
  } finally {
    db.close();
  }
}

function completeResearchTask(id: string, reportPath: string) {
  const now = Date.now();
  const db = openWebDb(false);
  try {
    db.prepare(`
      UPDATE research_tasks
      SET status = 'completed', updated_at = ?, completed_at = ?, report_path = ?, result_path = ?, failure_reason = NULL
      WHERE id = ?
    `).run(now, now, reportPath, reportPath, id);
    const row = db.prepare('SELECT topic_id, COALESCE(title, query, description, id) AS title FROM research_tasks WHERE id = ?').get(id) as { topic_id: string | null; title: string } | undefined;
    if (row?.topic_id) {
      db.prepare(`
        INSERT INTO research_reports (
          id, topic_id, task_id, title, report_uri, report_kind, created_at, updated_at, metadata_json
        ) VALUES (?, ?, ?, ?, ?, 'markdown', ?, ?, ?)
        ON CONFLICT(report_uri) DO UPDATE SET
          task_id = COALESCE(research_reports.task_id, excluded.task_id),
          topic_id = excluded.topic_id,
          updated_at = excluded.updated_at,
          failure_reason = NULL
      `).run(`report_${randomUUID()}`, row.topic_id, id, row.title, reportPath, now, now, jsonObject({ source: 'legacy-completion' }));
      refreshResearchTopicCounters(db, row.topic_id);
    }
  } finally {
    db.close();
  }
}

function failResearchTask(id: string, reason: string) {
  const now = Date.now();
  const db = openWebDb(false);
  try {
    db.prepare(`
      UPDATE research_tasks
      SET status = 'failed', updated_at = ?, completed_at = ?, failure_reason = ?
      WHERE id = ?
    `).run(now, now, reason, id);
  } finally {
    db.close();
  }
}

async function generateResearchReport(task: ResearchTaskDetailData): Promise<string> {
  const now = new Date().toISOString();
  const sources = await fetchResearchSources(task.query);
  const llmSynthesis = await synthesizeWithLlm(task, sources);
  const synthesis = llmSynthesis ?? buildLocalSynthesis(task.query, task.scope, sources);
  const evidenceLines = sources.map((source, index) => `${index + 1}. ${source.title}\n   ${source.snippet}\n   ${source.url}`).join('\n');

  return [
    `# ${task.topic}`,
    '',
    'OpenClaw（KIVO 调研任务）/ 2026-05-24',
    '',
    `请求人：${task.requestedBy}`,
    `调研范围：${task.scope}`,
    `生成时间：${now}`,
    '',
    '## 结论',
    synthesis.conclusion,
    '',
    '## 关键发现',
    ...synthesis.findings.map((item) => `- ${item}`),
    '',
    '## 可入库知识',
    ...synthesis.knowledge.map((item) => `- ${item}`),
    '',
    '## 来源',
    evidenceLines || '- 未拿到外部来源，本报告基于任务上下文生成。',
    '',
  ].join('\n');
}

async function fetchResearchSources(query: string): Promise<Array<{ title: string; snippet: string; url: string }>> {
  const tavilyKey = getTavilyApiKey();
  if (!tavilyKey) return [];
  try {
    const response = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: tavilyKey, query, search_depth: 'basic', max_results: 5 }),
    });
    if (!response.ok) return [];
    const data = await response.json() as { results?: Array<{ title?: string; content?: string; url?: string }> };
    return (data.results ?? []).map((item) => ({
      title: item.title ?? 'Untitled',
      snippet: item.content ?? '',
      url: item.url ?? '',
    })).filter((item) => item.title || item.snippet || item.url);
  } catch {
    return [];
  }
}

function getOpenClawConfig(): Record<string, unknown> | null {
  const configPath = '/root/.openclaw/openclaw.json';
  if (!fs.existsSync(configPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function getTavilyApiKey(): string | undefined {
  if (process.env.TAVILY_API_KEY || process.env.WEB_SEARCH_API_KEY) return process.env.TAVILY_API_KEY || process.env.WEB_SEARCH_API_KEY;
  const cfg = getOpenClawConfig();
  const plugins = cfg?.plugins as { entries?: Record<string, { config?: { webSearch?: { apiKey?: string } } }> } | undefined;
  return plugins?.entries?.tavily?.config?.webSearch?.apiKey;
}

function getPenguinMainConfig(): { baseUrl: string; apiKey: string; model: string } | null {
  const cfg = getOpenClawConfig();
  const provider = ((cfg?.models as { providers?: Record<string, { baseUrl?: string; apiKey?: string; api?: string; models?: Array<{ id?: string } | string> }> } | undefined)?.providers ?? {})['penguin-main'];
  const baseUrl = provider?.baseUrl;
  const apiKey = provider?.apiKey ?? provider?.api;
  const firstModel = Array.isArray(provider?.models) ? provider.models[0] : undefined;
  const model = typeof firstModel === 'string' ? firstModel : firstModel?.id;
  if (!baseUrl || !apiKey || !model) return null;
  return { baseUrl: baseUrl.replace(/\/$/, ''), apiKey, model };
}

async function synthesizeWithLlm(
  task: ResearchTaskDetailData,
  sources: Array<{ title: string; snippet: string; url: string }>,
): Promise<{ conclusion: string; findings: string[]; knowledge: string[] } | null> {
  if (shouldBypassExternalModelsInTests()) return null;
  const provider = getPenguinMainConfig();
  if (!provider) return null;
  const evidence = sources.map((source, index) => `${index + 1}. ${source.title}\n${source.snippet}\n${source.url}`).join('\n\n') || '无外部来源。';
  try {
    const response = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${provider.apiKey}` },
      body: JSON.stringify({
        model: provider.model,
        temperature: 0.2,
        messages: [
          { role: 'system', content: '你是 KIVO 的调研报告生成器。只输出 JSON，字段为 conclusion、findings、knowledge。findings 和 knowledge 是字符串数组，每组 3 条。' },
          { role: 'user', content: `调研问题：${task.query}\n范围：${task.scope}\n来源：\n${evidence}` },
        ],
      }),
    });
    if (!response.ok) return null;
    const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content;
    if (!content) return null;
    const parsed = JSON.parse(content) as { conclusion?: unknown; findings?: unknown; knowledge?: unknown };
    if (typeof parsed.conclusion !== 'string' || !Array.isArray(parsed.findings) || !Array.isArray(parsed.knowledge)) return null;
    return {
      conclusion: parsed.conclusion,
      findings: parsed.findings.filter((item): item is string => typeof item === 'string').slice(0, 5),
      knowledge: parsed.knowledge.filter((item): item is string => typeof item === 'string').slice(0, 5),
    };
  } catch {
    return null;
  }
}

function buildLocalSynthesis(query: string, scope: string, sources: Array<{ title: string; snippet: string; url: string }>) {
  const sourceHints = sources.slice(0, 3).map((item) => item.snippet || item.title).filter(Boolean);
  const evidence = sourceHints.length > 0 ? sourceHints.join('；') : `围绕「${query}」的任务上下文。`;
  return {
    conclusion: `围绕「${query}」的调研已完成。当前最有价值的沉淀是把范围「${scope}」拆成可复用事实、判断依据和后续行动，而不是只保存一次性搜索结果。`,
    findings: [
      `主题边界：${scope || query}`,
      `证据线索：${evidence.slice(0, 260)}`,
      '后续处理：采纳后会写入知识库，并保留调研报告路径用于追溯。',
    ],
    knowledge: [
      `事实：${query} 的调研报告已生成，报告内容可作为 research 来源入库。`,
      `方法：对调研结果先保留原始报告，再由采纳动作触发价值门禁和知识入库。`,
      `经验：调研任务必须有 pending → executing → completed / failed 的持续可见状态，避免 IM 指令执行后无前端反馈。`,
    ],
  };
}

export function updateResearchTaskPriority(id: string, priority: Priority): ResearchDashboardData | null {
  ensureResearchTables();
  const db = openWebDb(false);
  let topic = '';
  try {
    const row = db.prepare('SELECT COALESCE(title, query, description, id) AS topic FROM research_tasks WHERE id = ?').get(id) as { topic: string } | undefined;
    if (!row) return null;
    topic = row.topic;
    db.prepare('UPDATE research_tasks SET priority = ?, updated_at = ? WHERE id = ?').run(priority, Date.now(), id);
  } finally {
    db.close();
  }

  appendActivityEvent({ type: 'research_updated', label: '调研优先级调整', summary: `调研任务「${topic}」的优先级已调整为「${priority}」。`, href: '/research', tags: ['research', 'priority'] });
  return getResearchDashboardData();
}

export function deleteResearchTask(id: string): ResearchDashboardData | null {
  ensureResearchTables();
  const db = openWebDb(false);
  let topic = '';
  let deleted = false;
  try {
    const row = db.prepare('SELECT COALESCE(title, query, description, id) AS topic FROM research_tasks WHERE id = ?').get(id) as { topic: string } | undefined;
    if (!row) return null;
    topic = row.topic;
    deleted = db.prepare('UPDATE research_tasks SET status = ?, updated_at = ? WHERE id = ?').run('cancelled', Date.now(), id).changes > 0;
  } finally {
    db.close();
  }

  if (!deleted) return null;
  appendActivityEvent({ type: 'research_cancelled', label: '调研取消', summary: `调研任务「${topic}」已取消。`, href: '/research', tags: ['research', 'cancelled'] });
  return getResearchDashboardData();
}

export function setResearchAutoPaused(paused: boolean): ResearchDashboardData {
  setAutoResearchPausedValue(paused);
  appendActivityEvent({ type: paused ? 'research_paused' : 'research_resumed', label: paused ? '自动调研暂停' : '自动调研恢复', summary: paused ? '调研队列已进入静默模式。' : '调研队列已恢复自动处理。', href: '/research', tags: ['research', paused ? 'paused' : 'resumed'] });
  return getResearchDashboardData();
}

export async function adoptResearchTask(id: string): Promise<ResearchDashboardData | null> {
  ensureResearchTables();
  const task = getResearchTaskDetail(id);
  if (!task || task.status !== 'completed') return null;
  const reportContent = task.reportContent;
  if (!reportContent?.trim()) return null;

  const entryIds: string[] = [];
  const entries = buildEntriesFromReport(task, reportContent);
  for (const entry of entries) {
    const saved = await persistEntry(entry);
    if (saved) entryIds.push(entry.id);
  }

  const db = openWebDb(false);
  try {
    db.prepare(`
      UPDATE research_tasks
      SET adopted_at = ?, updated_at = ?, produced_entry_ids_json = ?
      WHERE id = ?
    `).run(Date.now(), Date.now(), safeJsonArray(entryIds), id);
  } finally {
    db.close();
  }

  appendActivityEvent({ type: 'research_adopted', label: '调研报告采纳', summary: `调研报告「${task.topic}」已采纳入知识库。`, href: '/research', tags: ['research', 'adopted'] });
  writeOperationLog('knowledge_change', `调研采纳: ${task.topic}`, `入库 ${entryIds.length} 条知识`, { action: 'research_adopt', task_id: id, report_path: task.reportPath, entry_ids: entryIds });
  return getResearchDashboardData();
}

export async function registerResearchTask(input: RegisterResearchTaskInput): Promise<{ topic: ResearchTopicRow; task: ResearchTaskRegistryRow }> {
  ensureResearchTables();
  const title = input.taskTitle.trim();
  if (!title) throw new Error('taskTitle is required');
  const now = Date.now();
  const db = openWebDb(false);
  try {
    const topic = await ensureTopicInDbSemantic(db, input.topicName);
    const id = `task_${randomUUID()}`;
    db.prepare(`
      INSERT INTO research_tasks (
        id, topic_id, title, query, description, scope, status, source_type, source_ref, actor_id, executor_id,
        requested_by, created_at, updated_at, started_at, highlighted, produced_entry_ids_json, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, 'executing', ?, ?, ?, ?, ?, ?, ?, ?, 0, '[]', ?)
    `).run(
      id,
      topic.id,
      title,
      input.query ?? title,
      input.query ?? title,
      input.topicName,
      input.sourceType ?? 'agent',
      input.sourceRef ?? null,
      input.actorId ?? null,
      input.executorId ?? null,
      input.actorId ?? 'agent',
      now,
      now,
      now,
      jsonObject(input.metadata),
    );
    refreshResearchTopicCounters(db, topic.id);
    const task = db.prepare('SELECT * FROM research_tasks WHERE id = ?').get(id) as ResearchTaskRegistryRow;
    return { topic, task };
  } finally {
    db.close();
  }
}

export function registerResearchReport(input: RegisterResearchReportInput): ResearchReportRow {
  ensureResearchTables();
  const reportUri = input.reportUri.trim();
  if (!reportUri) throw new Error('reportUri is required');
  const now = Date.now();
  const db = openWebDb(false);
  try {
    const task = db.prepare('SELECT id, topic_id, title, query FROM research_tasks WHERE id = ?').get(input.taskId) as { id: string; topic_id: string | null; title: string | null; query: string | null } | undefined;
    if (!task?.topic_id) throw new Error(`Research task not found: ${input.taskId}`);
    const title = (input.title ?? task.title ?? task.query ?? '调研报告').trim();
    db.prepare(`
      INSERT INTO research_reports (
        id, topic_id, task_id, title, report_uri, report_kind, external_content_hash, created_at, updated_at, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(report_uri) DO UPDATE SET
        topic_id = excluded.topic_id,
        task_id = excluded.task_id,
        title = excluded.title,
        report_kind = excluded.report_kind,
        external_content_hash = excluded.external_content_hash,
        updated_at = excluded.updated_at,
        failure_reason = NULL
    `).run(
      `report_${randomUUID()}`,
      task.topic_id,
      input.taskId,
      title,
      reportUri,
      input.reportKind ?? 'markdown',
      input.externalContentHash ?? null,
      now,
      now,
      jsonObject(input.metadata),
    );
    refreshResearchTopicCounters(db, task.topic_id);
    return db.prepare('SELECT * FROM research_reports WHERE report_uri = ?').get(reportUri) as ResearchReportRow;
  } finally {
    db.close();
  }
}

export function updateRegisteredResearchTaskStatus(input: UpdateRegisteredResearchTaskStatusInput): ResearchTaskRegistryRow {
  ensureResearchTables();
  if (!REGISTRY_STATUSES.has(input.status)) throw new Error(`Invalid research task status: ${input.status}`);
  const dbStatus = input.status === 'running' ? 'executing' : input.status;
  const now = Date.now();
  const db = openWebDb(false);
  try {
    const task = db.prepare('SELECT * FROM research_tasks WHERE id = ?').get(input.taskId) as ResearchTaskRegistryRow | undefined;
    if (!task) throw new Error(`Research task not found: ${input.taskId}`);
    const currentStatus = normalizeStatus(task.status);
    const isTerminal = currentStatus === 'completed' || currentStatus === 'failed' || currentStatus === 'cancelled';
    if (isTerminal && input.status !== currentStatus) {
      throw new Error(`Research task ${input.taskId} is already terminal: ${currentStatus}`);
    }
    db.prepare(`
      UPDATE research_tasks
      SET status = ?,
          updated_at = ?,
          completed_at = CASE WHEN ? IN ('completed', 'failed') THEN ? ELSE completed_at END,
          cancelled_at = CASE WHEN ? = 'cancelled' THEN ? ELSE cancelled_at END,
          failure_reason = CASE WHEN ? IN ('failed', 'cancelled') THEN ? ELSE NULL END,
          executor_id = COALESCE(?, executor_id)
      WHERE id = ?
    `).run(dbStatus, now, dbStatus, now, dbStatus, now, dbStatus, input.reason ?? null, input.executorId ?? null, input.taskId);
    if (input.reportUri) {
      registerResearchReport({
        taskId: input.taskId,
        title: input.reportTitle ?? task.title ?? undefined,
        reportUri: input.reportUri,
      });
      db.prepare('UPDATE research_tasks SET report_path = ?, result_path = ? WHERE id = ?').run(input.reportUri, input.reportUri, input.taskId);
    }
    return db.prepare('SELECT * FROM research_tasks WHERE id = ?').get(input.taskId) as ResearchTaskRegistryRow;
  } finally {
    db.close();
  }
}

type ExtractedResearchEntry = {
  type?: string;
  title?: string;
  summary?: string;
  content?: string;
  confidence?: number;
  tags?: string[];
  domain?: string;
};

function normalizeExtractedEntries(value: unknown): ExtractedResearchEntry[] {
  const entries = (value as { entries?: unknown })?.entries;
  if (!Array.isArray(entries)) return [];
  return entries
    .filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object')
    .map((item) => ({
      type: typeof item.type === 'string' ? item.type : 'fact',
      title: typeof item.title === 'string' ? item.title.slice(0, 120) : '调研结论',
      summary: typeof item.summary === 'string' ? item.summary : undefined,
      content: typeof item.content === 'string' ? item.content : undefined,
      confidence: typeof item.confidence === 'number' ? item.confidence : 0.86,
      tags: Array.isArray(item.tags) ? item.tags.filter((tag): tag is string => typeof tag === 'string') : [],
      domain: typeof item.domain === 'string' ? item.domain : undefined,
    }))
    .filter((item) => item.title && item.content)
    .slice(0, 12);
}

async function extractEntriesWithLlm(report: ResearchReportRow, topic: ResearchTopicRow, content: string): Promise<{ entries: ExtractedResearchEntry[]; model?: string }> {
  const response = await chatJson<{ entries?: ExtractedResearchEntry[] }>([
    {
      role: 'system',
      content: [
        '你是 KIVO 的调研报告入库提取器。必须只输出 JSON 对象。',
        '从整篇报告中提取可复用 Wiki 条目，不要编造报告中没有的内容。',
        'JSON schema: {"entries":[{"type":"fact|decision|methodology|experience","title":"<=80字","summary":"一句话","content":"可追溯正文","confidence":0.0-1.0,"tags":["..."],"domain":"领域"}]}',
      ].join('\n'),
    },
    {
      role: 'user',
      content: `调研主题：${topic.name}\n报告标题：${report.title}\n报告 URI：${report.report_uri}\n\n报告全文：\n${content}`,
    },
  ], { temperature: 0.1, maxTokens: 1800 });
  return { entries: normalizeExtractedEntries(response.data), model: response.raw.model };
}

function buildEntryFromExtraction(
  item: ExtractedResearchEntry,
  report: ResearchReportRow,
  topic: ResearchTopicRow,
  batchId: string,
  confirmedBy: string,
): KnowledgeEntry {
  const now = new Date();
  const type = ['fact', 'decision', 'methodology', 'experience'].includes(item.type ?? '') ? item.type as KnowledgeEntry['type'] : 'fact';
  const confidence = Math.max(0, Math.min(1, item.confidence ?? 0.86));
  return {
    id: `research-${batchId}-${randomUUID()}`,
    type,
    title: item.title ?? '调研结论',
    summary: item.summary ?? item.title ?? '调研报告提取条目',
    content: item.content ?? item.summary ?? item.title ?? '',
    source: {
      type: 'research',
      reference: report.report_uri,
      timestamp: now,
      context: `${topic.id}/${report.id}/${batchId}`,
      agent: confirmedBy,
    },
    confidence,
    status: 'active',
    tags: ['research', 'reference-report', topic.normalized_name, ...(item.tags ?? [])],
    domain: item.domain ?? topic.name,
    createdAt: now,
    updatedAt: now,
    version: 1,
    metadata: {
      domainData: {
        research: {
          researchTopicId: topic.id,
          researchReportId: report.id,
          researchBatchId: batchId,
          sourceReportUri: report.report_uri,
          confirmedBy,
        },
      },
    },
  };
}

function failReferenceBatch(reportId: string, batchId: string, reason: string, contentHash?: string, sourceType?: string): ConfirmResearchReportResult {
  const now = Date.now();
  const db = openWebDb(false);
  try {
    const report = db.prepare('SELECT * FROM research_reports WHERE id = ?').get(reportId) as ResearchReportRow;
    db.prepare(`
      UPDATE research_reference_batches
      SET status = 'failed', extracted_at = ?, error_message = ?, content_hash = COALESCE(?, content_hash), source_type = COALESCE(?, source_type)
      WHERE id = ?
    `).run(now, reason, contentHash ?? null, sourceType ?? null, batchId);
    db.prepare('UPDATE research_reports SET failure_reason = ?, updated_at = ? WHERE id = ?').run(reason, now, reportId);
    return { reportId, topicId: report.topic_id, status: 'failed', sourceType: sourceType === 'lark' ? 'lark' : 'local', contentHash, batchId, insertedCount: 0, failureReason: reason };
  } finally {
    db.close();
  }
}
function recordDuplicateReferenceBatch(
  report: ResearchReportRow,
  topic: ResearchTopicRow,
  batchId: string,
  existingBatchId: string,
  status: 'duplicate' | 'skipped',
  confirmedBy: string,
  sourceType: 'local' | 'lark',
  contentHash: string,
): ConfirmResearchReportResult {
  const now = Date.now();
  const db = openWebDb(false);
  try {
    if (status === 'duplicate') {
      db.prepare(`
        UPDATE research_reports
        SET is_reference = 1, reference_marked_at = ?, reference_marked_by = ?, content_hash = ?, failure_reason = NULL, updated_at = ?
        WHERE id = ?
      `).run(now, confirmedBy, contentHash, now, report.id);
    }
    db.prepare(`
      UPDATE research_reference_batches
      SET status = ?, content_hash = ?, extracted_at = ?, error_message = NULL, source_type = ?, metadata_json = ?
      WHERE id = ?
    `).run(status, contentHash, now, sourceType, jsonObject({ duplicateOfBatchId: existingBatchId }), batchId);
    return { reportId: report.id, topicId: topic.id, status, sourceType, contentHash, batchId, insertedCount: 0 };
  } finally {
    db.close();
  }
}

function claimReferenceBatch(
  report: ResearchReportRow,
  topic: ResearchTopicRow,
  batchId: string,
  confirmedBy: string,
  sourceType: 'local' | 'lark',
  contentHash: string,
): ConfirmResearchReportResult | null {
  const db = openWebDb(false);
  try {
    try {
      db.prepare('UPDATE research_reference_batches SET content_hash = ?, source_type = ? WHERE id = ?').run(contentHash, sourceType, batchId);
      return null;
    } catch (err) {
      const existing = db.prepare(`
        SELECT id, status FROM research_reference_batches
        WHERE report_id = ? AND content_hash = ? AND status IN ('extracting', 'completed') AND id != ?
        ORDER BY CASE status WHEN 'completed' THEN 0 ELSE 1 END, confirmed_at ASC
        LIMIT 1
      `).get(report.id, contentHash, batchId) as { id: string; status: string } | undefined;
      if (!existing) throw err;
      return recordDuplicateReferenceBatch(
        report,
        topic,
        batchId,
        existing.id,
        existing.status === 'completed' ? 'duplicate' : 'skipped',
        confirmedBy,
        sourceType,
        contentHash,
      );
    }
  } finally {
    db.close();
  }
}

export async function confirmResearchReportReference(input: ConfirmResearchReportInput): Promise<ConfirmResearchReportResult | null> {
  ensureResearchTables();
  const confirmedBy = input.confirmedBy.trim() || 'unknown';
  const db = openWebDb(false);
  let report: ResearchReportRow | undefined;
  let topic: ResearchTopicRow | undefined;
  let batchId = `batch_${randomUUID()}`;
  try {
    report = db.prepare('SELECT * FROM research_reports WHERE id = ?').get(input.reportId) as ResearchReportRow | undefined;
    if (!report) return null;
    topic = db.prepare('SELECT * FROM research_topics WHERE id = ?').get(report.topic_id) as ResearchTopicRow | undefined;
    if (!topic) throw new Error(`Research topic not found: ${report.topic_id}`);
    db.prepare(`
      INSERT INTO research_reference_batches (
        id, report_id, topic_id, status, confirmed_by, confirmed_at, extraction_prompt_version, metadata_json
      ) VALUES (?, ?, ?, 'extracting', ?, ?, ?, '{}')
    `).run(batchId, report.id, topic.id, confirmedBy, Date.now(), EXTRACTION_PROMPT_VERSION);
  } finally {
    db.close();
  }

  if (!report || !topic) return null;

  let fullReport: { content: string; sourceType: 'local' | 'lark' };
  let contentHash: string;
  try {
    fullReport = await readFullReport(report.report_uri);
    contentHash = calculateContentHash(fullReport.content);
  } catch (err) {
    return failReferenceBatch(report.id, batchId, err instanceof Error ? err.message : String(err));
  }

  const duplicateClaim = claimReferenceBatch(report, topic, batchId, confirmedBy, fullReport.sourceType, contentHash);
  if (duplicateClaim) return duplicateClaim;

  let extracted: { entries: ExtractedResearchEntry[]; model?: string };
  try {
    extracted = await extractEntriesWithLlm(report, topic, fullReport.content);
    if (extracted.entries.length === 0) throw new Error('LLM extraction returned no entries');
  } catch (err) {
    return failReferenceBatch(report.id, batchId, err instanceof Error ? err.message : String(err), contentHash, fullReport.sourceType);
  }

  const entryIds: string[] = [];
  for (const item of extracted.entries) {
    const entry = buildEntryFromExtraction(item, report, topic, batchId, confirmedBy);
    const saved = await persistEntry(entry);
    if (saved) entryIds.push(entry.id);
  }
  if (entryIds.length === 0) {
    return failReferenceBatch(report.id, batchId, 'No extracted entries passed persistence', contentHash, fullReport.sourceType);
  }

  const successDb = openWebDb(false);
  try {
    const now = Date.now();
    successDb.prepare(`
      UPDATE research_reports
      SET is_reference = 1, reference_marked_at = ?, reference_marked_by = ?, content_hash = ?, failure_reason = NULL, updated_at = ?
      WHERE id = ?
    `).run(now, confirmedBy, contentHash, now, report.id);
    successDb.prepare(`
      UPDATE research_reference_batches
      SET status = 'completed', content_hash = ?, extracted_at = ?, llm_provider_id = ?, llm_model = ?, extracted_summary = ?, inserted_count = ?, source_type = ?
      WHERE id = ?
    `).run(contentHash, now, 'penguin-kivo', extracted.model ?? null, `${entryIds.length} entries inserted`, entryIds.length, fullReport.sourceType, batchId);
    for (const entryId of entryIds) {
      successDb.prepare(`
        INSERT OR IGNORE INTO research_report_entries (id, batch_id, report_id, topic_id, entry_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(`rre_${randomUUID()}`, batchId, report.id, topic.id, entryId, now);
    }
    refreshResearchTopicCounters(successDb, topic.id);
  } finally {
    successDb.close();
  }

  appendActivityEvent({ type: 'research_adopted', label: '调研报告可参考', summary: `调研报告「${report.title}」已确认可参考并入库 ${entryIds.length} 条。`, href: '/research', tags: ['research', 'reference'] });
  return { reportId: report.id, topicId: topic.id, status: 'completed', sourceType: fullReport.sourceType, contentHash, batchId, insertedCount: entryIds.length };
}

function buildEntriesFromReport(task: ResearchTaskDetailData, reportContent: string): KnowledgeEntry[] {
  const now = new Date();
  const base = {
    source: {
      type: 'research' as const,
      reference: task.reportPath ?? `research:${task.id}`,
      timestamp: now,
      context: task.id,
      agent: task.requestedBy,
    },
    confidence: 0.86,
    status: 'active' as const,
    tags: ['research', ...task.expectedTypes],
    domain: task.scope,
    createdAt: now,
    updatedAt: now,
    version: 1,
    metadata: {
      domainData: {
        valueAssessment: {
          isHighValue: true,
          category: 'research_report',
          confidence: 0.86,
          reasoning: '用户主动采纳的调研报告，保留来源路径并通过仓储质量门禁。',
          dimensions: { timeliness: 1, crossScenario: 1, abstractness: 1 },
          assessedAt: now.toISOString(),
        },
      },
    },
  };

  return [
    {
      ...base,
      id: `research-${task.id}-fact`,
      type: 'fact',
      title: `${task.topic}：调研事实`,
      summary: `调研报告已完成并采纳：${task.topic}`,
      content: reportContent.slice(0, 4000),
      nature: 'fact',
      functionTag: 'constraint',
      knowledgeDomain: task.scope,
    },
    {
      ...base,
      id: `research-${task.id}-methodology`,
      type: 'methodology',
      title: `${task.topic}：调研处理方法`,
      summary: '调研结果采用报告留痕、人工采纳、质量门禁、知识入库的闭环。',
      content: `适用范围：${task.scope}\n\n调研问题：${task.query}\n\n处理方法：先生成可追溯报告，再由采纳动作触发质量门禁和知识入库，避免未经确认的搜索结果直接污染知识库。`,
      nature: 'methodology',
      functionTag: 'pattern',
      knowledgeDomain: task.scope,
    },
  ];
}

export function updateResearchHighlight(id: string, highlighted: boolean): ResearchDashboardData | null {
  ensureResearchTables();
  const db = openWebDb(false);
  let topic = '';
  let updated = false;
  try {
    const row = db.prepare('SELECT COALESCE(title, query, description, id) AS topic FROM research_tasks WHERE id = ?').get(id) as { topic: string } | undefined;
    if (!row) return null;
    topic = row.topic;
    updated = db.prepare('UPDATE research_tasks SET highlighted = ?, updated_at = ? WHERE id = ?').run(highlighted ? 1 : 0, Date.now(), id).changes > 0;
  } finally {
    db.close();
  }

  if (!updated) return null;
  appendActivityEvent({ type: 'research_highlighted', label: highlighted ? '调研标记重点' : '调研取消重点', summary: `调研任务「${topic}」${highlighted ? '已标记为重点' : '已取消重点标记'}。`, href: '/research', tags: ['research', 'highlight'] });
  return getResearchDashboardData();
}

export function updateResearchTaskStatusForTest(id: string, status: string, reportPath?: string): void {
  ensureResearchTables();
  const normalized = dbStatusForUi(status);
  const now = Date.now();
  const db = openWebDb(false);
  try {
    db.prepare(`
      UPDATE research_tasks
      SET status = ?, updated_at = ?, started_at = CASE WHEN ? = 'executing' THEN COALESCE(started_at, ?) ELSE started_at END,
          completed_at = CASE WHEN ? IN ('completed', 'failed') THEN ? ELSE completed_at END,
          report_path = COALESCE(?, report_path), result_path = COALESCE(?, result_path)
      WHERE id = ?
    `).run(normalized, now, normalized, now, normalized, now, reportPath ?? null, reportPath ?? null, id);
  } finally {
    db.close();
  }
}
