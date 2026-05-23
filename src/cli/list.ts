import { existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import Database from 'better-sqlite3';
import { DEFAULT_CONFIG } from '../config/types.js';

export interface ListOptions {
  type?: string;
  limit?: string;
  offset?: string;
  status?: string;
  json?: boolean;
}

interface EntryRow {
  id: string;
  type: string;
  title: string;
  content: string;
  confidence: number;
  status: string;
  tags_json: string;
  similar_sentences: string | null;
  domain: string | null;
  created_at: string;
  updated_at: string;
}

export async function runList(options: ListOptions = {}): Promise<string> {
  const dir = process.cwd();
  const configPath = join(dir, 'kivo.config.json');

  let dbPath = String(DEFAULT_CONFIG.dbPath);
  if (existsSync(configPath)) {
    const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
    if (typeof raw.dbPath === 'string') dbPath = raw.dbPath;
  }

  const resolvedDb = resolve(dir, dbPath);
  if (!existsSync(resolvedDb)) {
    return 'Database not found. Run "kivo init" first.';
  }

  const limit = options.limit ? parseInt(options.limit, 10) : 20;
  const offset = options.offset ? parseInt(options.offset, 10) : 0;

  if (isNaN(limit) || limit < 1) return 'Invalid --limit value.';
  if (isNaN(offset) || offset < 0) return 'Invalid --offset value.';

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (options.type) {
    conditions.push('type = ?');
    params.push(options.type);
  }
  if (options.status) {
    conditions.push('status = ?');
    params.push(options.status);
  }

  const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

  const db = new Database(resolvedDb, { readonly: true });
  const columns = db.prepare('PRAGMA table_info(entries)').all() as Array<{ name: string }>;
  const hasSimilarSentences = columns.some(c => c.name === 'similar_sentences');
  const ssCol = hasSimilarSentences ? ', similar_sentences' : '';
  let rows: EntryRow[];
  let total: number;
  try {
    total = (db.prepare(`SELECT COUNT(*) as cnt FROM entries ${whereClause}`).get(...params) as { cnt: number }).cnt;
    rows = db.prepare(`
      SELECT id, type, title, content, confidence, status, tags_json${ssCol}, domain, created_at, updated_at
      FROM entries ${whereClause}
      ORDER BY updated_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset) as EntryRow[];
  } finally {
    db.close();
  }

  if (options.json) {
    const items = rows.map(r => {
      let similarSentences: string[] | undefined;
      try {
        const parsed = JSON.parse(r.similar_sentences ?? '[]');
        similarSentences = Array.isArray(parsed) && parsed.length > 0 ? parsed : undefined;
      } catch { similarSentences = undefined; }
      return {
        id: r.id,
        type: r.type,
        title: r.title,
        content: r.content,
        confidence: r.confidence,
        status: r.status,
        tags: JSON.parse(r.tags_json),
        similarSentences,
        domain: r.domain,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      };
    });
    return JSON.stringify({ items, total, offset, limit, hasMore: offset + rows.length < total }, null, 2);
  }

  if (rows.length === 0) {
    return total === 0 ? 'No entries found.' : `No entries at offset ${offset} (total: ${total}).`;
  }

  const lines: string[] = [`Showing ${rows.length} of ${total} entries (offset: ${offset}):\n`];
  for (const row of rows) {
    const tags = JSON.parse(row.tags_json) as string[];
    lines.push(`  ${row.id.slice(0, 8)}  [${row.type}] ${row.title}`);
    lines.push(`           status: ${row.status}  confidence: ${row.confidence}  tags: ${tags.join(', ') || '(none)'}`);
    if (row.type === 'intent') {
      let ss: string[] = [];
      try { const p = JSON.parse(row.similar_sentences ?? '[]'); if (Array.isArray(p)) ss = p; } catch { /* ignore */ }
      if (ss.length > 0) {
        lines.push(`           similar: ${ss.join(' | ')}`);
      }
    }
  }
  return lines.join('\n');
}
