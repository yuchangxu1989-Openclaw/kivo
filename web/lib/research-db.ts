import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { shouldBypassExternalModelsInTests } from '@kivo/utils/test-runtime';

import { openWebDb } from './db';
import { appendActivityEvent } from './domain-stores';
import { logResearchComplete } from './operation-log-integration';
import { writeOperationLog } from './operation-log-db';
import type { Priority, ResearchDashboardData, ResearchReferenceBatchStatus, ResearchReport, ResearchStatus, ResearchTask, ResearchTaskRegistryItem, ResearchTopic } from './domain-types';
import type { KnowledgeEntry } from '@self-evolving-harness/kivo';
export type { ResearchDashboardData } from './domain-types';
import { persistEntry } from './kivo-engine';

const DEFAULT_EXPECTED_TYPES = ['fact', 'decision', 'methodology'];
const RESEARCH_AUTO_PAUSED_KEY = 'research:auto_paused';
const VALID_STATUSES = new Set(['pending', 'queued', 'executing', 'running', 'completed', 'failed', 'cancelled']);

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
      CREATE TABLE IF NOT EXISTS research_tasks (
        id TEXT PRIMARY KEY,
        query TEXT,
        requested_by TEXT,
        description TEXT,
        status TEXT,
        report_path TEXT,
        source_channel TEXT,
        created_at INTEGER,
        updated_at INTEGER,
        completed_at INTEGER,
        adopted_at INTEGER,
        produced_entry_ids_json TEXT
      );

      CREATE TABLE IF NOT EXISTS kivo_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);

    ensureColumn(db, 'research_tasks', 'query', 'TEXT');
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

    db.exec(`
      CREATE TABLE IF NOT EXISTS research_topics (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        normalized_name TEXT NOT NULL UNIQUE,
        description TEXT,
        embedding_json TEXT,
        task_count INTEGER NOT NULL DEFAULT 0,
        report_count INTEGER NOT NULL DEFAULT 0,
        reference_report_count INTEGER NOT NULL DEFAULT 0,
        wiki_entry_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER,
        updated_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS research_reports (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        topic_id TEXT,
        title TEXT NOT NULL,
        report_uri TEXT NOT NULL,
        report_kind TEXT,
        content_hash TEXT,
        external_content_hash TEXT,
        is_reference INTEGER NOT NULL DEFAULT 0,
        reference_marked_at INTEGER,
        reference_marked_by TEXT,
        source_type TEXT,
        failure_reason TEXT,
        created_at INTEGER,
        updated_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS research_reference_batches (
        id TEXT PRIMARY KEY,
        report_id TEXT NOT NULL,
        status TEXT NOT NULL,
        source_type TEXT,
        content_hash TEXT,
        confirmed_by TEXT NOT NULL,
        confirmed_at INTEGER,
        extracted_at INTEGER,
        inserted_count INTEGER NOT NULL DEFAULT 0,
        duplicate_of_batch_id TEXT,
        error_message TEXT
      );

      CREATE TABLE IF NOT EXISTS research_report_entries (
        report_id TEXT NOT NULL,
        entry_id TEXT NOT NULL,
        title TEXT,
        summary TEXT,
        PRIMARY KEY (report_id, entry_id)
      );
    `);

    ensureColumn(db, 'research_tasks', 'topic_id', 'TEXT');
    ensureColumn(db, 'research_tasks', 'source_type', 'TEXT');
    ensureColumn(db, 'research_tasks', 'source_ref', 'TEXT');
    ensureColumn(db, 'research_tasks', 'actor_id', 'TEXT');
    ensureColumn(db, 'research_tasks', 'executor_id', 'TEXT');
    ensureColumn(db, 'research_tasks', 'cancelled_at', 'INTEGER');
    ensureColumn(db, 'research_tasks', 'wiki_page_id', 'TEXT');


    db.prepare("UPDATE research_tasks SET query = COALESCE(query, title, description, '') WHERE query IS NULL OR query = ''").run();
    db.prepare("UPDATE research_tasks SET requested_by = COALESCE(requested_by, source_channel, 'unknown') WHERE requested_by IS NULL OR requested_by = ''").run();
    db.prepare("UPDATE research_tasks SET updated_at = COALESCE(updated_at, created_at, ?) WHERE updated_at IS NULL").run(Date.now());
    db.prepare("UPDATE research_tasks SET status = 'pending' WHERE status = 'queued'").run();
    db.prepare("UPDATE research_tasks SET status = 'executing' WHERE status = 'running'").run();
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

export function getResearchDashboardData(): ResearchDashboardData {
  ensureResearchTables();
  return {
    autoResearchPaused: getAutoResearchPaused(),
    tasks: selectResearchRows().map(mapResearchRow),
    topics: selectResearchTopics(),
  };
}

function selectResearchTopics(): ResearchTopic[] {
  const db = openWebDb(true);
  try {
    const topics = db.prepare('SELECT * FROM research_topics ORDER BY COALESCE(updated_at, created_at, 0) DESC, id DESC').all() as Array<Record<string, unknown>>;
    return topics.map((topic) => {
      const topicId = String(topic.id);
      const tasks = db.prepare('SELECT * FROM research_tasks WHERE topic_id = ? ORDER BY COALESCE(created_at, 0) DESC, id DESC').all(topicId) as Array<ResearchTaskRow & Record<string, unknown>>;
      const reportsByTask = new Map<string, ResearchReport[]>();
      const reports = db.prepare('SELECT * FROM research_reports WHERE topic_id = ? ORDER BY COALESCE(created_at, 0) DESC, id DESC').all(topicId) as Array<Record<string, unknown>>;
      for (const report of reports) {
        const mapped = mapResearchReportRow(db, report);
        const taskId = String(report.task_id);
        reportsByTask.set(taskId, [...(reportsByTask.get(taskId) ?? []), mapped]);
      }
      return {
        id: topicId,
        name: String(topic.name ?? ''),
        normalizedName: String(topic.normalized_name ?? ''),
        description: topic.description as string | null | undefined,
        createdAt: topic.created_at as number | string | null | undefined,
        updatedAt: topic.updated_at as number | string | null | undefined,
        taskCount: Number(topic.task_count ?? tasks.length),
        reportCount: Number(topic.report_count ?? reports.length),
        referenceReportCount: Number(topic.reference_report_count ?? reports.filter((r) => Number(r.is_reference ?? 0) === 1).length),
        wikiEntryCount: Number(topic.wiki_entry_count ?? 0),
        tasks: tasks.map((task) => mapRegistryTaskRow(task, reportsByTask.get(task.id) ?? [])),
      };
    });
  } finally {
    db.close();
  }
}

function mapRegistryTaskRow(row: ResearchTaskRow & Record<string, unknown>, reports: ResearchReport[]): ResearchTaskRegistryItem {
  return {
    id: row.id,
    title: row.title ?? row.query ?? row.description ?? row.id,
    query: row.query,
    status: normalizeStatus(row.status),
    sourceType: row.source_type as string | null | undefined,
    sourceRef: row.source_ref as string | null | undefined,
    actorId: row.actor_id as string | null | undefined,
    executorId: row.executor_id as string | null | undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    cancelledAt: row.cancelled_at as number | string | null | undefined,
    failureReason: row.failure_reason,
    reportPath: row.report_path,
    resultPath: row.result_path,
    reports,
  };
}

function mapResearchReportRow(db: ReturnType<typeof openWebDb>, row: Record<string, unknown>): ResearchReport {
  const reportId = String(row.id);
  const batches = db.prepare('SELECT * FROM research_reference_batches WHERE report_id = ? ORDER BY COALESCE(confirmed_at, 0) DESC, id DESC').all(reportId) as Array<Record<string, unknown>>;
  const entries = db.prepare('SELECT entry_id, title, summary FROM research_report_entries WHERE report_id = ? ORDER BY entry_id').all(reportId) as Array<{ entry_id: string; title?: string; summary?: string }>;
  return {
    id: reportId,
    title: String(row.title ?? ''),
    reportUri: String(row.report_uri ?? ''),
    reportKind: row.report_kind as string | undefined,
    contentHash: row.content_hash as string | undefined,
    externalContentHash: row.external_content_hash as string | undefined,
    isReference: Number(row.is_reference ?? 0) === 1,
    referenceMarkedAt: row.reference_marked_at as number | string | null | undefined,
    referenceMarkedBy: row.reference_marked_by as string | null | undefined,
    sourceType: row.source_type as string | undefined,
    failureReason: row.failure_reason as string | null | undefined,
    batchStatus: batches[0]?.status as ResearchReferenceBatchStatus | undefined,
    insertedCount: Number(batches[0]?.inserted_count ?? entries.length),
    wikiEntryCount: entries.length,
    wikiEntries: entries.map((entry) => ({ id: entry.entry_id, title: entry.title, summary: entry.summary })),
    entryIds: entries.map((entry) => entry.entry_id),
    referenceBatches: batches.map((batch) => ({
      id: String(batch.id),
      status: batch.status as ResearchReferenceBatchStatus,
      sourceType: batch.source_type as string | undefined,
      contentHash: batch.content_hash as string | undefined,
      confirmedBy: String(batch.confirmed_by ?? ''),
      confirmedAt: batch.confirmed_at as number | string | null | undefined,
      extractedAt: batch.extracted_at as number | string | null | undefined,
      failureReason: batch.error_message as string | null | undefined,
      insertedCount: Number(batch.inserted_count ?? 0),
      duplicateOfBatchId: batch.duplicate_of_batch_id as string | undefined,
    })),
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

export function createResearchTask(input: CreateResearchTaskInput): ResearchDashboardData {
  ensureResearchTables();
  const id = randomUUID();
  const now = Date.now();
  const query = (input.query ?? input.topic ?? '').trim();
  const scope = (input.scope ?? query).trim();
  const requestedBy = (input.requestedBy ?? 'unknown').trim() || 'unknown';

  const db = openWebDb(false);
  try {
    db.prepare(`
      INSERT INTO research_tasks (
        id, query, requested_by, title, description, scope, priority, budget_credits, expected_types_json,
        status, created_at, updated_at, highlighted, report_path, result_path, produced_entry_ids_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, 0, NULL, NULL, '[]')
    `).run(
      id,
      query,
      requestedBy,
      query,
      query,
      scope,
      input.priority,
      input.budgetCredits,
      JSON.stringify(input.expectedTypes),
      now,
      now,
    );
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


function normalizeTopicName(name: string): string {
  return name.toLowerCase().replace(/\s+/g, '').replace(/调研|研究/g, '');
}

function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; aa += a[i] * a[i]; bb += b[i] * b[i]; }
  const denom = Math.sqrt(aa) * Math.sqrt(bb);
  return denom === 0 ? 0 : dot / denom;
}

async function embedTopic(name: string): Promise<number[] | null> {
  if (shouldBypassExternalModelsInTests()) return null;
  try {
    const response = await fetch('http://localhost:9876/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: name }),
    });
    if (!response.ok) return null;
    const data = await response.json() as { data?: Array<{ embedding?: number[] }> };
    return data.data?.[0]?.embedding ?? null;
  } catch { return null; }
}

async function resolveTopic(topicName: string): Promise<{ id: string; name: string; normalizedName: string }> {
  ensureResearchTables();
  const normalizedName = normalizeTopicName(topicName);
  const db = openWebDb(false);
  try {
    const exact = db.prepare('SELECT id, name, normalized_name FROM research_topics WHERE normalized_name = ?').get(normalizedName) as { id: string; name: string; normalized_name: string } | undefined;
    if (exact) return { id: exact.id, name: exact.name, normalizedName: exact.normalized_name };
  } finally { db.close(); }

  const embedding = await embedTopic(topicName);
  const db2 = openWebDb(false);
  try {
    if (embedding) {
      const topics = db2.prepare('SELECT id, name, normalized_name, embedding_json FROM research_topics').all() as Array<{ id: string; name: string; normalized_name: string; embedding_json: string | null }>;
      let best: { id: string; name: string; normalized_name: string } | null = null;
      let bestScore = 0;
      for (const topic of topics) {
        if (!topic.embedding_json) continue;
        try {
          const vector = JSON.parse(topic.embedding_json) as number[];
          const score = cosine(embedding, vector);
          if (score > bestScore) { bestScore = score; best = topic; }
        } catch { /* ignore invalid vector */ }
      }
      if (best && bestScore >= 0.95) return { id: best.id, name: best.name, normalizedName: best.normalized_name };
    }
    const now = Date.now();
    const id = `topic-${randomUUID()}`;
    db2.prepare('INSERT INTO research_topics (id, name, normalized_name, embedding_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, topicName, normalizedName, embedding ? JSON.stringify(embedding) : null, now, now);
    return { id, name: topicName, normalizedName };
  } finally { db2.close(); }
}

function refreshTopicCounts(topicId: string): void {
  const db = openWebDb(false);
  try {
    const taskCount = (db.prepare('SELECT COUNT(*) AS c FROM research_tasks WHERE topic_id = ?').get(topicId) as { c: number }).c;
    const reportCount = (db.prepare('SELECT COUNT(*) AS c FROM research_reports WHERE topic_id = ?').get(topicId) as { c: number }).c;
    const referenceReportCount = (db.prepare('SELECT COUNT(*) AS c FROM research_reports WHERE topic_id = ? AND is_reference = 1').get(topicId) as { c: number }).c;
    const wikiEntryCount = (db.prepare('SELECT COUNT(*) AS c FROM research_report_entries e JOIN research_reports r ON r.id = e.report_id WHERE r.topic_id = ?').get(topicId) as { c: number }).c;
    db.prepare('UPDATE research_topics SET task_count = ?, report_count = ?, reference_report_count = ?, wiki_entry_count = ?, updated_at = ? WHERE id = ?')
      .run(taskCount, reportCount, referenceReportCount, wikiEntryCount, Date.now(), topicId);
  } finally { db.close(); }
}

function sourceTypeForUri(uri: string): string {
  return uri.startsWith('lark:') || uri.startsWith('feishu:') ? 'lark' : 'local';
}

function readReferenceContent(reportUri: string): { sourceType: string; content?: string; failure?: string } {
  const sourceType = sourceTypeForUri(reportUri);
  if (sourceType === 'lark') {
    try {
      const out = execFileSync('lark-cli', ['doc', 'read', reportUri], { encoding: 'utf8', timeout: 30000 });
      const parsed = JSON.parse(out) as { data?: { markdown?: string; content?: string } };
      const content = parsed.data?.markdown ?? parsed.data?.content ?? '';
      return content.trim() ? { sourceType, content } : { sourceType, failure: 'lark-cli returned empty content' };
    } catch (err) {
      return { sourceType, failure: `lark-cli failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
  const abs = reportAbsolutePath(reportUri);
  const root = projectRoot();
  if (!abs || !abs.startsWith(root + path.sep)) return { sourceType, failure: `Report path escapes workspace: ${reportUri}` };
  if (!fs.existsSync(abs)) return { sourceType, failure: `Report not found: ${reportUri}` };
  return { sourceType, content: fs.readFileSync(abs, 'utf8') };
}

async function extractEntriesFromReport(taskId: string, reportId: string, topicName: string, content: string): Promise<Array<{ id: string; title: string; summary?: string }>> {
  const entryId = `research-${reportId}-fact`;
  const title = content.split('\n').map((line) => line.replace(/^#+\s*/, '').trim()).find(Boolean) ?? topicName;
  const entry: KnowledgeEntry = {
    id: entryId,
    type: 'fact',
    title,
    summary: title,
    content: content.trim(),
    source: { type: 'research', reference: `research:${reportId}`, timestamp: new Date(), context: taskId },
    confidence: 0.9,
    status: 'active',
    tags: ['research'],
    domain: topicName,
    createdAt: new Date(),
    updatedAt: new Date(),
    version: 1,
  };
  await persistEntry(entry);
  return [{ id: entryId, title, summary: title }];
}

export async function registerResearchTask(input: { topicName: string; taskTitle: string; query?: string; sourceType?: string; sourceRef?: string; actorId?: string; executorId?: string; metadata?: object }) {
  const topic = await resolveTopic(input.topicName.trim());
  const now = Date.now();
  const taskId = `task-${randomUUID()}`;
  const db = openWebDb(false);
  try {
    db.prepare(`INSERT INTO research_tasks (id, topic_id, query, requested_by, title, description, scope, priority, budget_credits, expected_types_json, status, source_type, source_ref, actor_id, executor_id, created_at, updated_at, highlighted, produced_entry_ids_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'medium', 20, ?, 'pending', ?, ?, ?, ?, ?, ?, 0, '[]')`)
      .run(taskId, topic.id, input.query ?? input.taskTitle, input.actorId ?? 'unknown', input.taskTitle, input.taskTitle, input.topicName, JSON.stringify(DEFAULT_EXPECTED_TYPES), input.sourceType ?? null, input.sourceRef ?? null, input.actorId ?? null, input.executorId ?? null, now, now);
  } finally { db.close(); }
  refreshTopicCounts(topic.id);
  return { topic, task: { id: taskId, title: input.taskTitle } };
}

export function registerResearchReport(input: { taskId: string; reportUri: string; title?: string; reportKind?: string; externalContentHash?: string; metadata?: object }) {
  ensureResearchTables();
  const db = openWebDb(false);
  try {
    const task = db.prepare('SELECT topic_id FROM research_tasks WHERE id = ?').get(input.taskId) as { topic_id: string | null } | undefined;
    const id = `report-${randomUUID()}`;
    const now = Date.now();
    const sourceType = sourceTypeForUri(input.reportUri);
    db.prepare(`INSERT INTO research_reports (id, task_id, topic_id, title, report_uri, report_kind, external_content_hash, source_type, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, input.taskId, task?.topic_id ?? null, input.title ?? input.reportUri, input.reportUri, input.reportKind ?? null, input.externalContentHash ?? null, sourceType, now, now);
    if (task?.topic_id) refreshTopicCounts(task.topic_id);
    return { id, taskId: input.taskId, title: input.title ?? input.reportUri, reportUri: input.reportUri };
  } finally { db.close(); }
}

export function updateRegisteredResearchTaskStatus(input: { taskId: string; status: 'running' | 'completed' | 'failed' | 'cancelled'; reason?: string; reportUri?: string; reportTitle?: string; executorId?: string }) {
  ensureResearchTables();
  const db = openWebDb(false);
  let topicId: string | null = null;
  try {
    const now = Date.now();
    const dbStatus = input.status === 'running' ? 'executing' : input.status;
    const row = db.prepare('SELECT topic_id FROM research_tasks WHERE id = ?').get(input.taskId) as { topic_id: string | null } | undefined;
    topicId = row?.topic_id ?? null;
    db.prepare(`UPDATE research_tasks SET status = ?, failure_reason = ?, executor_id = COALESCE(?, executor_id), updated_at = ?, started_at = CASE WHEN ? = 'executing' THEN COALESCE(started_at, ?) ELSE started_at END, completed_at = CASE WHEN ? IN ('completed', 'failed', 'cancelled') THEN ? ELSE completed_at END, cancelled_at = CASE WHEN ? = 'cancelled' THEN ? ELSE cancelled_at END, report_path = COALESCE(?, report_path), result_path = COALESCE(?, result_path) WHERE id = ?`)
      .run(dbStatus, input.reason ?? null, input.executorId ?? null, now, dbStatus, now, dbStatus, now, dbStatus, now, input.reportUri ?? null, input.reportUri ?? null, input.taskId);
  } finally { db.close(); }
  if (input.status === 'completed' && input.reportUri) {
    registerResearchReport({ taskId: input.taskId, title: input.reportTitle, reportUri: input.reportUri });
  } else if (topicId) refreshTopicCounts(topicId);
  return getResearchTaskDetail(input.taskId) ?? { id: input.taskId, status: input.status };
}

export async function confirmResearchReportReference(input: { reportId: string; confirmedBy: string }) {
  ensureResearchTables();
  const db = openWebDb(false);
  const report = db.prepare('SELECT * FROM research_reports WHERE id = ?').get(input.reportId) as Record<string, unknown> | undefined;
  db.close();
  if (!report) return null;
  const read = readReferenceContent(String(report.report_uri));
  const batchId = `batch-${randomUUID()}`;
  const now = Date.now();
  const writeBatch = (status: ResearchReferenceBatchStatus, values: { hash?: string; inserted?: number; duplicateOf?: string; error?: string; entries?: Array<{ id: string; title: string; summary?: string }> }) => {
    const wdb = openWebDb(false);
    try {
      wdb.prepare(`INSERT INTO research_reference_batches (id, report_id, status, source_type, content_hash, confirmed_by, confirmed_at, extracted_at, inserted_count, duplicate_of_batch_id, error_message)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(batchId, input.reportId, status, read.sourceType, values.hash ?? null, input.confirmedBy, now, now, values.inserted ?? 0, values.duplicateOf ?? null, values.error ?? null);
      if (status === 'completed') {
        wdb.prepare('UPDATE research_reports SET content_hash = ?, is_reference = 1, reference_marked_at = ?, reference_marked_by = ?, source_type = ?, failure_reason = NULL, updated_at = ? WHERE id = ?')
          .run(values.hash, now, input.confirmedBy, read.sourceType, now, input.reportId);
        for (const entry of values.entries ?? []) {
          wdb.prepare('INSERT OR IGNORE INTO research_report_entries (report_id, entry_id, title, summary) VALUES (?, ?, ?, ?)').run(input.reportId, entry.id, entry.title, entry.summary ?? null);
        }
      } else if (status === 'failed') {
        wdb.prepare('UPDATE research_reports SET failure_reason = ?, source_type = ?, updated_at = ? WHERE id = ?').run(values.error, read.sourceType, now, input.reportId);
      }
    } finally { wdb.close(); }
    if (report.topic_id) refreshTopicCounts(String(report.topic_id));
    return { id: batchId, reportId: input.reportId, status, sourceType: read.sourceType, contentHash: values.hash, insertedCount: values.inserted ?? 0, duplicateOfBatchId: values.duplicateOf, failureReason: values.error };
  };
  if (read.failure || !read.content) return writeBatch('failed', { error: read.failure ?? 'empty content' });
  const normalized = read.content.trim();
  const hash = createHash('sha256').update(normalized, 'utf8').digest('hex');
  const existingDb = openWebDb(true);
  try {
    const existing = existingDb.prepare("SELECT id FROM research_reference_batches WHERE report_id = ? AND content_hash = ? AND status = 'completed' LIMIT 1").get(input.reportId, hash) as { id: string } | undefined;
    if (existing) return writeBatch('duplicate', { hash, duplicateOf: existing.id });
  } finally { existingDb.close(); }
  const entries = await extractEntriesFromReport(String(report.task_id), input.reportId, String(report.title ?? ''), normalized);
  return writeBatch('completed', { hash, inserted: entries.length, entries });
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
