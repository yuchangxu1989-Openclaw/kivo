import { existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import Database from 'better-sqlite3';
import { DEFAULT_CONFIG } from '../config/types.js';
import { ensureUsageColumns, recordUsage } from '../governance/health-monitor.js';

export interface QueryFilterOptions {
  nature?: string;
  functionTag?: string;
  domain?: string;
}

export async function runQuery(queryText: string, filters?: QueryFilterOptions): Promise<string> {
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

  // Try BGE vector search first
  const vectorResults = await tryVectorSearch(resolvedDb, queryText, filters);
  if (vectorResults) {
    trackUsageFromResults(resolvedDb, vectorResults.ids);
    return vectorResults.text;
  }

  // FTS + keyword search (used when vector search has no results)
  const ftsResult = ftsSearch(resolvedDb, queryText, filters);
  if (ftsResult.ids.length > 0) {
    trackUsageFromResults(resolvedDb, ftsResult.ids);
  }
  return ftsResult.text;
}

/**
 * Track usage for retrieved entry IDs (opens a writable connection).
 */
function trackUsageFromResults(dbPath: string, entryIds: string[]): void {
  if (entryIds.length === 0) return;
  try {
    const db = new Database(dbPath);
    ensureUsageColumns(db);
    recordUsage(db, entryIds);
    db.close();
  } catch {
    // Non-critical: don't fail the query if usage tracking fails
  }
}

/**
 * BGE vector search: embed the query, then cosine similarity search.
 * Returns null if BGE is not available or no embeddings exist (graceful fallback).
 */
async function tryVectorSearch(dbPath: string, queryText: string, filters?: QueryFilterOptions): Promise<{ text: string; ids: string[] } | null> {
  try {
    // Quick check: does the DB even have an embedding column?
    const checkDb = new Database(dbPath, { readonly: true });
    const columns = checkDb.prepare('PRAGMA table_info(entries)').all() as Array<{ name: string }>;
    const hasEmbedding = columns.some(c => c.name === 'embedding');
    if (!hasEmbedding) {
      checkDb.close();
      return null;
    }
    const embCount = (checkDb.prepare('SELECT COUNT(*) as cnt FROM entries WHERE embedding IS NOT NULL').get() as { cnt: number }).cnt;
    checkDb.close();
    if (embCount === 0) return null;

    const { BgeEmbedder } = await import('../extraction/bge-embedder.js');
    if (!BgeEmbedder.isAvailable()) return null;

    const { VectorStore } = await import('../search/vector-store.js');
    const vectorStore = new VectorStore({ dbPath });

    const embedder = new BgeEmbedder();
    const queryVector = await embedder.embed(queryText);
    const results = vectorStore.searchSimilar(queryVector, 5);
    vectorStore.close();

    if (results.length === 0) return null;

    // Fetch full entry details
    const db = new Database(dbPath, { readonly: true });
    const vCols = db.prepare('PRAGMA table_info(entries)').all() as Array<{ name: string }>;
    const vHasSS = vCols.some(c => c.name === 'similar_sentences');
    const lines: string[] = [`Found ${results.length} result(s) for "${queryText}" (vector search):\n`];
    const hitIds: string[] = [];

    for (const result of results) {
      if (result.score < 0.3) continue; // skip very low similarity
      const selectCols = vHasSS
        ? 'id, type, title, content, confidence, tags_json, similar_sentences'
        : 'id, type, title, content, confidence, tags_json';
      const row = db.prepare(
        `SELECT ${selectCols} FROM entries WHERE id = ?`
      ).get(result.entryId) as { id: string; type: string; title: string; content: string; confidence: number; tags_json: string; similar_sentences?: string | null } | undefined;

      if (!row) continue;

      hitIds.push(row.id);

      const tags = JSON.parse(row.tags_json) as string[];
      lines.push(`[${row.type}] ${row.title} (similarity: ${result.score.toFixed(3)})`);
      lines.push(`  ${row.content.slice(0, 120)}${row.content.length > 120 ? '...' : ''}`);
      lines.push(`  confidence: ${row.confidence}  tags: ${tags.join(', ')}`);
      if (row.type === 'intent' && vHasSS) {
        let ss: string[] = [];
        try { const p = JSON.parse(row.similar_sentences ?? '[]'); if (Array.isArray(p)) ss = p; } catch { /* ignore */ }
        if (ss.length > 0) lines.push(`  similar: ${ss.join(' | ')}`);
      }
      lines.push('');
    }

    db.close();

    // If all results were below threshold, return null to fall through
    if (lines.length <= 1) return null;

    return { text: lines.join('\n'), ids: hitIds };
  } catch {
    // BGE not available or error - fall through to FTS
    return null;
  }
}

/** FTS + keyword search */
function ftsSearch(dbPath: string, queryText: string, filters?: QueryFilterOptions): { text: string; ids: string[] } {
  const db = new Database(dbPath, { readonly: true });

  // Build dimension filter clauses
  const dimConditions: string[] = [];
  const dimParams: unknown[] = [];
  if (filters?.nature) {
    dimConditions.push('e.nature = ?');
    dimParams.push(filters.nature);
  }
  if (filters?.functionTag) {
    dimConditions.push('e.function_tag = ?');
    dimParams.push(filters.functionTag);
  }
  if (filters?.domain) {
    dimConditions.push('e.knowledge_domain = ?');
    dimParams.push(filters.domain);
  }
  const dimClause = dimConditions.length > 0 ? ' AND ' + dimConditions.join(' AND ') : '';

  // Check if dimension columns exist
  const hasDimCols = (() => {
    try {
      const cols = db.prepare('PRAGMA table_info(entries)').all() as Array<{ name: string }>;
      return cols.some(c => c.name === 'nature');
    } catch { return false; }
  })();
  const effectiveDimClause = hasDimCols ? dimClause : '';
  const effectiveDimParams = hasDimCols ? dimParams : [];

  // If only dimension filters (no text query), return filtered entries
  if (!queryText && effectiveDimClause) {
    const rows = db.prepare(
      `SELECT e.id, e.type, e.title, e.content, e.confidence, e.tags_json, e.nature, e.function_tag, e.knowledge_domain FROM entries e WHERE 1=1${effectiveDimClause} ORDER BY e.updated_at DESC LIMIT 20`
    ).all(...effectiveDimParams) as Array<{ id: string; type: string; title: string; content: string; confidence: number; tags_json: string; nature: string | null; function_tag: string | null; knowledge_domain: string | null }>;
    db.close();
    if (rows.length === 0) return { text: 'No results matching the specified filters.', ids: [] };
    return { text: formatSearchResults(rows, `filter: ${dimConditions.join(', ')}`), ids: rows.map(r => r.id) };
  }

  type RowType = { id: string; type: string; title: string; content: string; confidence: number; tags_json: string; nature?: string | null; function_tag?: string | null; knowledge_domain?: string | null };
  let rows: RowType[] = [];
  const extraCols = hasDimCols ? ', e.nature, e.function_tag, e.knowledge_domain' : '';
  const sanitized = queryText.trim();

  // Trigram tokenizer requires >= 3 chars; skip FTS for shorter queries (e.g. 2-char Chinese terms)
  if (sanitized.length >= 3) {
    try {
      rows = db.prepare(`
        SELECT e.id, e.type, e.title, e.content, e.confidence, e.tags_json${extraCols}
        FROM entries e
        JOIN entries_fts ON entries_fts.rowid = e.rowid
        WHERE entries_fts MATCH ?${effectiveDimClause}
        ORDER BY rank
        LIMIT 5
      `).all(sanitized, ...effectiveDimParams) as RowType[];
    } catch {
      rows = [];
    }
  }

  if (rows.length === 0) {
    rows = db.prepare(`
      SELECT id, type, title, content, confidence, tags_json${hasDimCols ? ', nature, function_tag, knowledge_domain' : ''}
      FROM entries e
      WHERE (title LIKE ? OR content LIKE ? OR tags_json LIKE ?)${effectiveDimClause}
      ORDER BY confidence DESC
      LIMIT 5
    `).all(`%${queryText}%`, `%${queryText}%`, `%${queryText}%`, ...effectiveDimParams) as RowType[];
  }

  if (rows.length === 0) {
    const keywords = extractKeywords(queryText).slice(0, 10);
    if (keywords.length > 0) {
      const conditions = keywords.map(() => '(title LIKE ? OR content LIKE ? OR tags_json LIKE ?)').join(' OR ');
      const params = keywords.flatMap(k => [`%${k}%`, `%${k}%`, `%${k}%`]);
      rows = db.prepare(`
        SELECT id, type, title, content, confidence, tags_json${hasDimCols ? ', nature, function_tag, knowledge_domain' : ''}
        FROM entries e
        WHERE (${conditions})${effectiveDimClause}
        ORDER BY confidence DESC
        LIMIT 5
      `).all(...params, ...effectiveDimParams) as RowType[];
    }
  }

  db.close();

  if (rows.length === 0) {
    return { text: `No results for "${queryText}".`, ids: [] };
  }

  return { text: formatSearchResults(rows, queryText), ids: rows.map(r => r.id) };
}

function formatSearchResults(
  rows: Array<{ id?: string; type: string; title: string; content: string; confidence: number; tags_json: string; nature?: string | null; function_tag?: string | null; knowledge_domain?: string | null }>,
  label: string,
): string {
  const lines: string[] = [`Found ${rows.length} result(s) for "${label}":\n`];
  for (const row of rows) {
    const tags = JSON.parse(row.tags_json) as string[];
    lines.push(`[${row.type}] ${row.title}`);
    lines.push(`  ${row.content.slice(0, 120)}${row.content.length > 120 ? '...' : ''}`);
    let meta = `  confidence: ${row.confidence}  tags: ${tags.join(', ')}`;
    if (row.nature || row.function_tag || row.knowledge_domain) {
      meta += `  nature: ${row.nature ?? '-'}  function: ${row.function_tag ?? '-'}  domain: ${row.knowledge_domain ?? '-'}`;
    }
    lines.push(meta);
    lines.push('');
  }
  return lines.join('\n');
}

const STOP_WORDS = new Set(['帮我', '我要', '我想', '请', '怎么', '如何', '一个', '写个', '做个', '给我', '帮', '我', '个', '的', '了', '在', '是', 'the', 'a', 'an', 'is', 'how', 'to', 'do', 'can', 'i', 'me', 'my']);

function extractKeywords(text: string): string[] {
  const tokens: string[] = [];
  const parts = text.match(/[a-zA-Z0-9]+|[\u4e00-\u9fff]{2,}|[\u4e00-\u9fff]/g) ?? [];
  for (const part of parts) {
    if (part.length >= 2 && !STOP_WORDS.has(part.toLowerCase())) {
      tokens.push(part);
    }
  }
  const cjk = text.replace(/[^\u4e00-\u9fff]/g, '');
  for (let i = 0; i < cjk.length - 1; i++) {
    const bigram = cjk.slice(i, i + 2);
    if (!STOP_WORDS.has(bigram) && !tokens.includes(bigram)) {
      tokens.push(bigram);
    }
  }
  return tokens;
}
