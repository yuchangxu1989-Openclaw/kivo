import Database from 'better-sqlite3';
import path from 'path';

const DB_PATH = process.env.KIVO_DB_PATH || path.resolve(process.cwd(), '../kivo.db');

interface ResearchTaskRow {
  id: string;
  title: string;
  description: string;
  scope: string;
  status: string;
  priority: string;
  budget_credits: number;
  expected_types_json: string;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
  adopted_at: number | null;
  highlighted: number;
  failure_reason: string | null;
  produced_entry_ids_json: string | null;
  result_path: string | null;
  wiki_page_id: string | null;
}

type ResearchStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
type Priority = '高' | '中' | '低';

function mapPriority(dbPriority: string): Priority {
  if (dbPriority === 'high') return '高';
  if (dbPriority === 'low') return '低';
  return '中';
}

function mapStatus(dbStatus: string): ResearchStatus {
  if (dbStatus === 'pending') return 'queued';
  if (dbStatus === 'running') return 'running';
  if (dbStatus === 'completed') return 'completed';
  if (dbStatus === 'failed') return 'failed';
  if (dbStatus === 'cancelled') return 'cancelled';
  return 'queued';
}

function formatRelative(ts: number): string {
  const diff = Date.now() - ts * 1000;
  const minute = 60 * 1000;
  const hour = 60 * minute;
  if (diff < minute) return '刚刚';
  if (diff < hour) return `${Math.max(1, Math.round(diff / minute))} 分钟前`;
  if (diff < 24 * hour) return `${Math.max(1, Math.round(diff / hour))} 小时前`;
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(new Date(ts * 1000));
}

function parseJsonArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((i): i is string => typeof i === 'string') : [];
  } catch { return []; }
}

export function loadResearchTasksFromDb(): {
  autoResearchPaused: boolean;
  tasks: Array<{
    id: string;
    topic: string;
    scope: string;
    status: ResearchStatus;
    priority: Priority;
    createdAt: string;
    budgetCredits: number;
    expectedTypes: string[];
    resultSummary?: string;
    knowledgeCount?: number;
    failureReason?: string;
    resultEntryIds?: string[];
    adopted?: boolean;
    highlighted?: boolean;
  }>;
} {
  let db: Database.Database | null = null;
  try {
    db = new Database(DB_PATH, { readonly: true });
    db.pragma('journal_mode = WAL');

    const rows = db.prepare(
      'SELECT * FROM research_tasks ORDER BY created_at DESC'
    ).all() as ResearchTaskRow[];

    const tasks = rows.map((row) => {
      const expectedTypes = parseJsonArray(row.expected_types_json);
      const resultEntryIds = parseJsonArray(row.produced_entry_ids_json);
      const knowledgeCount = resultEntryIds.length;
      const isCompleted = row.status === 'completed';

      const task: ReturnType<typeof loadResearchTasksFromDb>['tasks'][number] = {
        id: row.id,
        topic: row.title || row.description,
        scope: row.scope || row.description,
        status: mapStatus(row.status),
        priority: mapPriority(row.priority),
        createdAt: formatRelative(row.created_at),
        budgetCredits: row.budget_credits,
        expectedTypes,
        failureReason: row.failure_reason ?? undefined,
        resultEntryIds: resultEntryIds.length > 0 ? resultEntryIds : undefined,
        knowledgeCount: knowledgeCount > 0 ? knowledgeCount : undefined,
        adopted: row.adopted_at !== null,
        highlighted: row.highlighted === 1,
      };

      if (isCompleted && row.result_path) {
        task.resultSummary = `调研报告已生成：${row.title}`;
      }

      return task;
    });

    return { autoResearchPaused: false, tasks };
  } catch (err) {
    console.error('Failed to load research tasks from DB:', err);
    return { autoResearchPaused: false, tasks: [] };
  } finally {
    db?.close();
  }
}

export function deleteResearchTaskFromDb(id: string): boolean {
  let db: Database.Database | null = null;
  try {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    const result = db.prepare('DELETE FROM research_tasks WHERE id = ?').run(id);
    return (result.changes ?? 0) > 0;
  } catch (err) {
    console.error('Failed to delete research task from DB:', err);
    return false;
  } finally {
    db?.close();
  }
}

export function updateResearchTaskPriorityInDb(id: string, priority: Priority): boolean {
  let db: Database.Database | null = null;
  try {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    const dbPriority = priority === '高' ? 'high' : priority === '低' ? 'low' : 'medium';
    const result = db.prepare(
      'UPDATE research_tasks SET priority = ?, updated_at = ? WHERE id = ?'
    ).run(dbPriority, Date.now(), id);
    return (result.changes ?? 0) > 0;
  } catch (err) {
    console.error('Failed to update research task priority in DB:', err);
    return false;
  } finally {
    db?.close();
  }
}

export function persistResearchTask(task: {
  topic: string; scope: string; priority: Priority;
  budgetCredits: number; expectedTypes: string[];
}): string | null {
  let db: Database.Database | null = null;
  try {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    const { randomUUID } = require('crypto');
    const id = randomUUID();
    const now = Date.now();
    const dbPriority = task.priority === '高' ? 'high' : task.priority === '低' ? 'low' : 'medium';

    db.prepare(`
      INSERT INTO research_tasks (id, title, description, scope, priority, budget_credits, expected_types_json, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `).run(
      id, task.topic, task.topic, task.scope,
      dbPriority, task.budgetCredits, JSON.stringify(task.expectedTypes),
      now, now,
    );
    return id;
  } catch (err) {
    console.error('Failed to persist research task:', err);
    return null;
  } finally {
    db?.close();
  }
}
