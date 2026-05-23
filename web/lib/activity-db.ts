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

/**
 * Get recent activity from the DB by querying recently updated entries.
 */
export function getRecentActivityFromDb(limit: number = 20, typeFilter: string = 'all'): ActivityEvent[] {
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
