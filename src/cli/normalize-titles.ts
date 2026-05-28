/**
 * FR-N07: 知识条目命名规范 CLI
 *
 * `kivo normalize-titles` — 扫描所有条目，对不符合命名规范的标题自动重命名
 * `kivo normalize-titles --dry-run` — 只显示会改什么，不实际改
 *
 * 命名规范：标题 ≤20 字符，格式为 `[类型]关键词`（如 `[决策]向量搜索阈值`）
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import Database from 'better-sqlite3';
import { DEFAULT_CONFIG } from '../config/types.js';

export interface NormalizeTitlesOptions {
  dryRun?: boolean;
  json?: boolean;
  domain?: string;
}

export interface NormalizeTitlesResult {
  total: number;
  nonCompliant: number;
  renamed: number;
  changes: Array<{
    id: string;
    oldTitle: string;
    newTitle: string;
  }>;
}

interface EntryRow {
  id: string;
  type: string;
  title: string;
  content: string;
  domain: string | null;
}

const TYPE_LABEL_MAP: Record<string, string> = {
  intent: '意图',
  methodology: '方法',
  fact: '事实',
  experience: '经验',
  decision: '决策',
  meta: '元知',
};

const TITLE_HARD_LIMIT = 20;

/**
 * Check if a title already conforms to the naming convention: `[类型]关键词` and ≤20 chars.
 */
function isCompliant(title: string, type: string): boolean {
  if (title.length > TITLE_HARD_LIMIT) return false;
  const label = TYPE_LABEL_MAP[type];
  if (!label) return title.length <= TITLE_HARD_LIMIT;
  return title.startsWith(`[${label}]`);
}

/**
 * Normalize a title to conform to `[类型]关键词` format, ≤20 chars total.
 */
function normalizeTitle(title: string, type: string): string {
  const label = TYPE_LABEL_MAP[type] ?? '知识';
  const prefix = `[${label}]`;
  const maxKeywordLen = TITLE_HARD_LIMIT - prefix.length;

  // Strip existing bracket prefix if present (e.g. already has [决策] or [fact])
  let keyword = title.replace(/^\[[^\]]*\]/, '').trim();

  // Remove parenthetical content
  keyword = keyword.replace(/[（(][^)）]*[)）]/g, '').trim();

  // If there's a colon, keep only the most informative part
  const colonMatch = keyword.match(/^(.+?)[：:](.*)/s);
  if (colonMatch) {
    const before = colonMatch[1].trim();
    const after = colonMatch[2].trim();
    // Pick the shorter meaningful part
    keyword = before.length <= maxKeywordLen ? before : after.length <= maxKeywordLen ? after : before;
  }

  // Truncate keyword to fit
  if (keyword.length > maxKeywordLen) {
    keyword = keyword.slice(0, maxKeywordLen - 1) + '…';
  }

  // Fallback if keyword is empty
  if (!keyword) {
    keyword = title.slice(0, maxKeywordLen - 1) + '…';
  }

  return `${prefix}${keyword}`;
}

export async function runNormalizeTitles(options: NormalizeTitlesOptions = {}): Promise<string> {
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

  const db = new Database(resolvedDb);
  try {
    let query = `SELECT id, type, title, content, domain FROM entries WHERE status = 'active'`;
    const params: string[] = [];
    if (options.domain) {
      query += ` AND (domain = ? OR knowledge_domain = ?)`;
      params.push(options.domain, options.domain);
    }
    query += ` ORDER BY created_at ASC`;

    const entries = db.prepare(query).all(...params) as EntryRow[];
    const result: NormalizeTitlesResult = {
      total: entries.length,
      nonCompliant: 0,
      renamed: 0,
      changes: [],
    };

    const updateStmt = db.prepare(`UPDATE entries SET title = ?, updated_at = ? WHERE id = ?`);
    const now = new Date().toISOString();

    for (const entry of entries) {
      if (isCompliant(entry.title, entry.type)) continue;

      result.nonCompliant++;
      const newTitle = normalizeTitle(entry.title, entry.type);

      // Skip if normalization produces the same title
      if (newTitle === entry.title) continue;

      result.changes.push({
        id: entry.id,
        oldTitle: entry.title,
        newTitle,
      });

      if (!options.dryRun) {
        updateStmt.run(newTitle, now, entry.id);
        result.renamed++;
      }
    }

    // Rebuild FTS after renames
    if (!options.dryRun && result.renamed > 0) {
      try {
        db.exec(`INSERT INTO entries_fts(entries_fts) VALUES('rebuild')`);
      } catch { /* non-fatal */ }
    }

    if (options.json) {
      return JSON.stringify(result, null, 2);
    }

    const lines: string[] = [];
    lines.push(`📝 知识条目命名规范检查 (FR-N07)`);
    lines.push(`总条目: ${result.total} | 不合规: ${result.nonCompliant} | ${options.dryRun ? '将重命名' : '已重命名'}: ${options.dryRun ? result.changes.length : result.renamed}`);
    lines.push('');

    if (result.changes.length === 0) {
      lines.push('✅ 所有条目标题均符合命名规范');
    } else {
      lines.push(options.dryRun ? '以下条目将被重命名:' : '以下条目已重命名:');
      lines.push('');
      for (const change of result.changes) {
        lines.push(`  ${change.oldTitle} → ${change.newTitle}`);
      }
    }

    return lines.join('\n');
  } finally {
    db.close();
  }
}
