/**
 * Activity feed from real DB data.
 * Queries the entries table for recent changes and formats them as activity events.
 */

import Database from 'better-sqlite3';
import path from 'path';
import type { ActivityEvent } from './demo-dashboard-data';

const DB_PATH = process.env.KIVO_DB_PATH || path.resolve(process.cwd(), '../kivo.db');

let db: Database.Database | null = null;

function getDb(): Database.Database {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
  }
  return db;
}

function formatRelative(date: Date): string {
  const diff = Date.now() - date.getTime();
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (diff < minute) return '刚刚';
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
  if (diff < 7 * day) return `${Math.floor(diff / day)} 天前`;
  return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' }).format(date);
}

const TYPE_LABELS: Record<string, string> = {
  fact: '事实',
  decision: '决策',
  methodology: '方法论',
  experience: '经验',
  intent: '意图',
  meta: '元知识',
  term: '术语',
  wiki_page: '领域知识',
  wiki_directory: '目录',
  wiki_space: '知识空间',
};

function entryToActivityEvent(row: {
  id: string;
  type: string;
  title: string;
  summary: string;
  domain: string | null;
  updated_at: string;
  created_at: string;
}): ActivityEvent {
  const updatedAt = new Date(row.updated_at);
  const createdAt = new Date(row.created_at);
  const isNew = Math.abs(updatedAt.getTime() - createdAt.getTime()) < 60 * 1000;

  const typeLabel = TYPE_LABELS[row.type] || row.type;
  const label = isNew ? '新知识入库' : '知识更新';
  const summary = isNew
    ? `「${row.title || row.summary}」已写入${typeLabel}域。`
    : `「${row.title || row.summary}」已更新。`;

  const tags: string[] = [row.type, 'knowledge'];
  if (row.domain) tags.push(row.domain);

  return {
    id: `act-${row.id.slice(0, 8)}`,
    eventId: `evt-${row.id.slice(0, 8)}`,
    type: isNew ? 'knowledge_created' : 'knowledge_created',
    label,
    summary,
    href: row.type.startsWith('wiki') ? '/wiki' : `/knowledge/${row.id}`,
    tags,
    time: formatRelative(updatedAt),
    occurredAt: updatedAt.toISOString(),
  };
}


const OPERATION_TYPE_META: Record<string, { label: string; type: string; tags: string[] }> = {
  knowledge_change: { label: '知识变更', type: 'knowledge_created', tags: ['knowledge'] },
  document_import: { label: '文档导入', type: 'knowledge_imported', tags: ['import', 'knowledge'] },
  research_complete: { label: '调研完成', type: 'research_completed', tags: ['research'] },
  governance_run: { label: '治理运行', type: 'rule_changed', tags: ['governance'] },
  vectorization_batch: { label: '向量化批次', type: 'rule_changed', tags: ['embedding', 'governance'] },
};

function operationLogToActivityEvent(row: {
  id: number;
  event_type: string;
  title: string;
  detail: string;
  metadata_json: string;
  created_at: string;
}): ActivityEvent {
  const occurredAt = new Date(row.created_at);
  const meta = OPERATION_TYPE_META[row.event_type] || { label: '系统活动', type: 'rule_changed', tags: ['system'] };
  const summary = row.detail?.trim() || row.title;

  return {
    id: `op-${row.id}`,
    eventId: `op-${row.id}`,
    type: meta.type,
    label: meta.label,
    summary,
    href: '/activity',
    tags: [...meta.tags, row.event_type],
    time: formatRelative(occurredAt),
    occurredAt: occurredAt.toISOString(),
  };
}

function operationTypeCondition(typeFilter: string): string {
  if (typeFilter === 'knowledge') return "AND event_type = 'knowledge_change'";
  if (typeFilter === 'import') return "AND event_type = 'document_import'";
  if (typeFilter === 'research') return "AND event_type = 'research_complete'";
  if (typeFilter === 'governance' || typeFilter === 'system') return "AND event_type IN ('governance_run', 'vectorization_batch')";
  if (typeFilter === 'embedding') return "AND event_type = 'vectorization_batch'";
  return '';
}

function getRecentOperationLogActivity(limit: number, typeFilter: string): ActivityEvent[] {
  const database = getDb();
  try {
    const table = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'operation_logs'").get();
    if (!table) return [];

    const rows = database.prepare(`
      SELECT id, event_type, title, detail, metadata_json, created_at
      FROM operation_logs
      WHERE 1 = 1 ${operationTypeCondition(typeFilter)}
      ORDER BY datetime(created_at) DESC, id DESC
      LIMIT ?
    `).all(limit) as Array<{
      id: number;
      event_type: string;
      title: string;
      detail: string;
      metadata_json: string;
      created_at: string;
    }>;

    return rows.map(operationLogToActivityEvent);
  } catch {
    return [];
  }
}

/**
 * Get recent activity from the DB by querying recently updated entries.
 */
export function getRecentActivityFromDb(limit: number = 20, typeFilter: string = 'all'): ActivityEvent[] {
  const operationEvents = getRecentOperationLogActivity(limit, typeFilter);
  if (operationEvents.length > 0 || typeFilter === 'embedding') return operationEvents;

  const database = getDb();

  let typeCondition = '';
  if (typeFilter === 'knowledge') {
    typeCondition = "AND type NOT IN ('wiki_space', 'wiki_directory')";
  } else if (typeFilter === 'import') {
    typeCondition = "AND type IN ('wiki_page', 'wiki_directory')";
  } else if (typeFilter === 'system' || typeFilter === 'governance') {
    typeCondition = "AND type IN ('wiki_space', 'wiki_directory')";
  }

  const query = `
    SELECT id, type, title, summary, domain, updated_at, created_at
    FROM entries
    WHERE status = 'active' ${typeCondition}
    ORDER BY updated_at DESC
    LIMIT ?
  `;

  try {
    const rows = database.prepare(query).all(limit) as Array<{
      id: string;
      type: string;
      title: string;
      summary: string;
      domain: string | null;
      updated_at: string;
      created_at: string;
    }>;

    return rows.map(entryToActivityEvent);
  } catch {
    return [];
  }
}
