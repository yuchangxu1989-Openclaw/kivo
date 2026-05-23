import { existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import Database from 'better-sqlite3';
import { DEFAULT_CONFIG } from '../config/types.js';
import { shortenKnowledgeTitle } from '../extraction/extraction-utils.js';

export interface UpdateOptions {
  title?: string;
  content?: string;
  tags?: string;
  confidence?: string;
  domain?: string;
  status?: string;
  json?: boolean;
}

export async function runUpdate(id: string, options: UpdateOptions = {}): Promise<string> {
  if (!id) {
    return 'Usage: kivo update <id> [--title "..."] [--content "..."] [--tags "a,b"] [--confidence 0.8] [--status active] [--json]';
  }

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

  const setClauses: string[] = [];
  const params: unknown[] = [];

  if (options.title !== undefined) {
    setClauses.push('title = ?');
    params.push(shortenKnowledgeTitle(options.title, options.content ?? ''));
  }
  if (options.content !== undefined) {
    setClauses.push('content = ?');
    params.push(options.content);
  }
  if (options.tags !== undefined) {
    const tags = options.tags.split(',').map(t => t.trim()).filter(Boolean);
    setClauses.push('tags_json = ?');
    params.push(JSON.stringify(tags));
  }
  if (options.confidence !== undefined) {
    const conf = parseFloat(options.confidence);
    if (isNaN(conf) || conf < 0 || conf > 1) {
      return 'Confidence must be a number between 0 and 1.';
    }
    setClauses.push('confidence = ?');
    params.push(conf);
  }
  if (options.domain !== undefined) {
    setClauses.push('domain = ?');
    params.push(options.domain || null);
  }
  if (options.status !== undefined) {
    setClauses.push('status = ?');
    params.push(options.status);
  }

  if (setClauses.length === 0) {
    return 'Nothing to update. Provide at least one of: --title, --content, --tags, --confidence, --domain, --status';
  }

  setClauses.push('version = version + 1');
  setClauses.push('updated_at = ?');
  const now = new Date().toISOString();
  params.push(now);
  params.push(id);

  const db = new Database(resolvedDb);
  try {
    // Check if entry exists (support both full ID and prefix match)
    let targetId = id;
    const exact = db.prepare('SELECT id FROM entries WHERE id = ?').get(id) as { id: string } | undefined;
    if (!exact) {
      const prefix = db.prepare('SELECT id FROM entries WHERE id LIKE ?').all(`${id}%`) as { id: string }[];
      if (prefix.length === 0) {
        return `Entry "${id}" not found.`;
      }
      if (prefix.length > 1) {
        return `Ambiguous ID prefix "${id}". Matches: ${prefix.map(p => p.id.slice(0, 8)).join(', ')}`;
      }
      targetId = prefix[0].id;
      params[params.length - 1] = targetId;
    }

    const result = db.prepare(`UPDATE entries SET ${setClauses.join(', ')} WHERE id = ?`).run(...params);

    if (result.changes === 0) {
      return `Entry "${id}" not found.`;
    }

    if (options.json) {
      const row = db.prepare('SELECT * FROM entries WHERE id = ?').get(targetId) as Record<string, unknown>;
      return JSON.stringify(row, null, 2);
    }

    return `✓ Updated entry ${targetId.slice(0, 8)}`;
  } finally {
    db.close();
  }
}
