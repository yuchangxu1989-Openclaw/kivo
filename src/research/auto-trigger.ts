import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { LLMProvider } from '../adapter/llm-provider.js';
import type { KnowledgeEntry } from '../types/index.js';
import { ensureOperationalTables, openOperationalDb, type OperationalDbOptions } from '../utils/operational-db.js';
import { GapDetector, type KnowledgeLink } from './gap-detector.js';
import type { KnowledgeGap } from './gap-detection-types.js';
import { ResearchScheduler } from './research-scheduler.js';
import type { SchedulerConfig } from './research-scheduler-types.js';
import { ResearchTaskGenerator } from './research-task-generator.js';
import type { ResearchTask } from './research-task-types.js';

export interface RetrievalMissRecord {
  query: string;
  timestamp: Date;
  resultCount?: number;
  topRelevance?: number;
  context?: string;
}

export interface ResearchAutoTriggerOptions extends OperationalDbOptions {
  llm: LLMProvider;
  entries?: () => KnowledgeEntry[] | Promise<KnowledgeEntry[]>;
  links?: () => KnowledgeLink[] | Promise<KnowledgeLink[]>;
  recentLimit?: number;
  lowRelevanceThreshold?: number;
  scheduler?: ResearchScheduler;
  taskGenerator?: ResearchTaskGenerator;
  schedulerConfig?: SchedulerConfig;
  now?: () => Date;
}

export interface ResearchAutoTriggerRunResult {
  gaps: KnowledgeGap[];
  generated: ResearchTask[];
  scheduled: ResearchTask[];
  skippedExisting: KnowledgeGap[];
}

interface ResearchTaskRow {
  task_json: string;
}

interface MetricsSearchRow {
  query: string;
  timestamp: string;
  result_count: number;
}

const DEFAULT_SCHEDULER_CONFIG: SchedulerConfig = {
  maxConcurrentResearchTasks: 3,
  frequencyMs: 60 * 60 * 1000,
  dailyBudget: 20,
};

export class ResearchAutoTrigger {
  private readonly llm: LLMProvider;
  private readonly entries?: () => KnowledgeEntry[] | Promise<KnowledgeEntry[]>;
  private readonly links?: () => KnowledgeLink[] | Promise<KnowledgeLink[]>;
  private readonly recentLimit: number;
  private readonly lowRelevanceThreshold: number;
  private readonly scheduler: ResearchScheduler;
  private readonly taskGenerator: ResearchTaskGenerator;
  private readonly schedulerConfig: SchedulerConfig;
  private readonly dbOptions: OperationalDbOptions;
  private readonly now: () => Date;

  constructor(options: ResearchAutoTriggerOptions) {
    this.llm = options.llm;
    this.entries = options.entries;
    this.links = options.links;
    this.recentLimit = options.recentLimit ?? 100;
    this.lowRelevanceThreshold = options.lowRelevanceThreshold ?? 0.35;
    this.scheduler = options.scheduler ?? new ResearchScheduler(options);
    this.taskGenerator = options.taskGenerator ?? new ResearchTaskGenerator({ now: options.now });
    this.schedulerConfig = { ...DEFAULT_SCHEDULER_CONFIG, ...options.schedulerConfig };
    this.dbOptions = { cwd: options.cwd, dbPath: options.dbPath };
    this.now = options.now ?? (() => new Date());
  }

  async detectGaps(): Promise<KnowledgeGap[]> {
    const detector = new GapDetector({ now: this.now });

    for (const miss of await this.loadRecentMisses()) {
      detector.recordQueryMiss(miss.query, miss.context);
    }

    const entries = await this.loadEntries();
    const links = this.links ? await this.links() : [];
    return detector.detect(entries, links).gaps;
  }

  async generateTask(gap: KnowledgeGap): Promise<ResearchTask> {
    const baseTask = this.taskGenerator.generateFromGap(gap);
    const description = await this.generateTaskDescription(gap, baseTask);
    return {
      ...baseTask,
      title: description.title || baseTask.title,
      objective: description.objective || baseTask.objective,
      completionCriteria: description.completionCriteria.length > 0
        ? description.completionCriteria
        : baseTask.completionCriteria,
      strategy: {
        ...baseTask.strategy,
        searchQueries: description.searchQueries.length > 0
          ? description.searchQueries
          : baseTask.strategy.searchQueries,
        notes: description.notes || baseTask.strategy.notes,
      },
    };
  }

  scheduleTask(task: ResearchTask): ResearchTask[] {
    this.persistTask(task);
    const decision = this.scheduler.schedule([task], this.schedulerConfig);
    return decision.runnable;
  }

  async run(): Promise<ResearchAutoTriggerRunResult> {
    const gaps = await this.detectGaps();
    const existingGapIds = this.loadExistingGapIds();
    const generated: ResearchTask[] = [];
    const scheduled: ResearchTask[] = [];
    const skippedExisting: KnowledgeGap[] = [];

    for (const gap of gaps) {
      if (existingGapIds.has(gap.id) || existingGapIds.has(gapFingerprint(gap))) {
        skippedExisting.push(gap);
        continue;
      }

      const task = await this.generateTask(gap);
      generated.push(task);
      scheduled.push(...this.scheduleTask(task));
    }

    return { gaps, generated, scheduled, skippedExisting };
  }

  recordRetrieval(query: string, resultCount: number, topRelevance?: number, context?: string): void {
    const db = openOperationalDb(this.dbOptions);
    try {
      ensureResearchAutoTriggerTables(db);
      const lowRelevanceMiss = topRelevance !== undefined && topRelevance < this.lowRelevanceThreshold;
      if (resultCount > 0 && !lowRelevanceMiss) return;
      db.prepare(`
        INSERT INTO research_retrieval_misses (id, query, result_count, top_relevance, context, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(randomUUID(), query, resultCount, topRelevance ?? null, context ?? null, new Date(this.now()).toISOString());
    } finally {
      db.close();
    }
  }

  private async loadRecentMisses(): Promise<RetrievalMissRecord[]> {
    const db = openOperationalDb({ ...this.dbOptions, readonly: true });
    try {
      const misses: RetrievalMissRecord[] = [];

      if (tableExists(db, 'research_retrieval_misses')) {
        const rows = db.prepare(`
          SELECT query, result_count, top_relevance, context, created_at
          FROM research_retrieval_misses
          ORDER BY created_at DESC
          LIMIT ?
        `).all(this.recentLimit) as Array<{
          query: string;
          result_count: number | null;
          top_relevance: number | null;
          context: string | null;
          created_at: string;
        }>;
        misses.push(...rows.map((row) => ({
          query: row.query,
          resultCount: row.result_count ?? undefined,
          topRelevance: row.top_relevance ?? undefined,
          context: row.context ?? undefined,
          timestamp: new Date(row.created_at),
        })));
      }

      if (tableExists(db, 'metrics_search')) {
        const rows = db.prepare(`
          SELECT query, timestamp, result_count
          FROM metrics_search
          WHERE result_count = 0
          ORDER BY timestamp DESC
          LIMIT ?
        `).all(this.recentLimit) as MetricsSearchRow[];
        misses.push(...rows.map((row) => ({
          query: row.query,
          resultCount: row.result_count,
          timestamp: new Date(row.timestamp),
        })));
      }

      return misses
        .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
        .slice(0, this.recentLimit);
    } finally {
      db.close();
    }
  }

  private async loadEntries(): Promise<KnowledgeEntry[]> {
    if (this.entries) {
      return this.entries();
    }

    const db = openOperationalDb({ ...this.dbOptions, readonly: true });
    try {
      if (!tableExists(db, 'entries')) return [];
      const rows = db.prepare(`
        SELECT id, type, title, content, summary, source_json, confidence, status, tags_json, domain,
               version, supersedes, similar_sentences, nature, function_tag, knowledge_domain, created_at, updated_at
        FROM entries
        WHERE status = 'active'
      `).all() as EntryRow[];
      return rows.map(rowToEntry);
    } finally {
      db.close();
    }
  }

  private async generateTaskDescription(gap: KnowledgeGap, baseTask: ResearchTask): Promise<{
    title: string;
    objective: string;
    searchQueries: string[];
    completionCriteria: string[];
    notes?: string;
  }> {
    const prompt = `你是调研任务规划器。基于知识缺口生成可执行调研任务。必须基于语义理解，不得用关键词规则套模板。

输出纯 JSON：
{"title":"...","objective":"...","searchQueries":["..."],"completionCriteria":["..."],"notes":"..."}

知识缺口：
${JSON.stringify(gap, null, 2)}

基础任务草案：
${JSON.stringify(baseTask, dateReplacer, 2)}`;
    const raw = await this.llm.complete(prompt);
    return normalizeTaskDescription(raw);
  }

  private persistTask(task: ResearchTask): void {
    const db = openOperationalDb(this.dbOptions);
    try {
      ensureResearchAutoTriggerTables(db);
      db.prepare(`
        INSERT OR IGNORE INTO research_tasks (id, gap_id, gap_fingerprint, status, priority, task_json, created_at, updated_at)
        VALUES (?, ?, ?, 'queued', ?, ?, ?, ?)
      `).run(
        task.id,
        task.gapId,
        gapFingerprintFromTask(task),
        task.priority,
        JSON.stringify(task, dateReplacer),
        task.createdAt.toISOString(),
        new Date(this.now()).toISOString(),
      );
    } finally {
      db.close();
    }
  }

  private loadExistingGapIds(): Set<string> {
    const db = openOperationalDb(this.dbOptions);
    try {
      ensureResearchAutoTriggerTables(db);
      const rows = db.prepare('SELECT task_json FROM research_tasks WHERE status IN (\'queued\', \'running\', \'completed\')')
        .all() as ResearchTaskRow[];
      const ids = new Set<string>();
      for (const row of rows) {
        try {
          const task = JSON.parse(row.task_json) as { gapId?: string; gapType?: string; scope?: { topic?: string; domain?: string } };
          if (task.gapId) ids.add(task.gapId);
          ids.add(gapFingerprintFromTaskLike(task));
        } catch {
          // Ignore malformed historical task rows.
        }
      }
      return ids;
    } finally {
      db.close();
    }
  }
}

function ensureResearchAutoTriggerTables(db: Database.Database): void {
  ensureOperationalTables(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS research_retrieval_misses (
      id TEXT PRIMARY KEY,
      query TEXT NOT NULL,
      result_count INTEGER,
      top_relevance REAL,
      context TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS research_tasks (
      id TEXT PRIMARY KEY,
      gap_id TEXT NOT NULL,
      gap_fingerprint TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      priority TEXT NOT NULL,
      task_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_research_retrieval_misses_created_at ON research_retrieval_misses(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_research_tasks_gap ON research_tasks(gap_id, gap_fingerprint);
    CREATE INDEX IF NOT EXISTS idx_research_tasks_status ON research_tasks(status);
  `);
}

function tableExists(db: Database.Database, name: string): boolean {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
  return Boolean(row);
}

function normalizeTaskDescription(raw: string): {
  title: string;
  objective: string;
  searchQueries: string[];
  completionCriteria: string[];
  notes?: string;
} {
  const fallback = { title: '', objective: '', searchQueries: [] as string[], completionCriteria: [] as string[] };
  try {
    const parsed = JSON.parse(stripJsonFence(raw)) as Record<string, unknown>;
    return {
      title: typeof parsed.title === 'string' ? parsed.title : '',
      objective: typeof parsed.objective === 'string' ? parsed.objective : '',
      searchQueries: toStringArray(parsed.searchQueries),
      completionCriteria: toStringArray(parsed.completionCriteria),
      notes: typeof parsed.notes === 'string' ? parsed.notes : undefined,
    };
  } catch {
    return fallback;
  }
}

function stripJsonFence(raw: string): string {
  let cleaned = raw.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }
  return cleaned;
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : [];
}

function gapFingerprint(gap: KnowledgeGap): string {
  const evidence = gap.evidence as { pattern?: string; domain?: string; signal?: string; description?: string };
  return [gap.type, evidence.pattern, evidence.domain, evidence.signal, evidence.description].filter(Boolean).join(':');
}

function gapFingerprintFromTask(task: ResearchTask): string {
  return [task.gapType, task.scope.topic, task.scope.domain].filter(Boolean).join(':');
}

function gapFingerprintFromTaskLike(task: { gapType?: string; scope?: { topic?: string; domain?: string } }): string {
  return [task.gapType, task.scope?.topic, task.scope?.domain].filter(Boolean).join(':');
}

function dateReplacer(_key: string, value: unknown): unknown {
  return value instanceof Date ? value.toISOString() : value;
}

interface EntryRow {
  id: string;
  type: KnowledgeEntry['type'];
  title: string;
  content: string;
  summary: string;
  source_json: string;
  confidence: number;
  status: KnowledgeEntry['status'];
  tags_json: string;
  domain: string | null;
  version: number;
  supersedes: string | null;
  similar_sentences: string | null;
  nature: KnowledgeEntry['nature'] | null;
  function_tag: KnowledgeEntry['functionTag'] | null;
  knowledge_domain: string | null;
  created_at: string;
  updated_at: string;
}

function rowToEntry(row: EntryRow): KnowledgeEntry {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    content: row.content,
    summary: row.summary,
    source: safeJson(row.source_json, { type: 'system', reference: 'unknown', timestamp: new Date(row.created_at) }),
    confidence: row.confidence,
    status: row.status,
    tags: safeJson(row.tags_json, []),
    domain: row.domain ?? undefined,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    version: row.version,
    supersedes: row.supersedes ?? undefined,
    similarSentences: safeJson(row.similar_sentences ?? '[]', []),
    nature: row.nature ?? undefined,
    functionTag: row.function_tag ?? undefined,
    knowledgeDomain: row.knowledge_domain ?? undefined,
  };
}

function safeJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
