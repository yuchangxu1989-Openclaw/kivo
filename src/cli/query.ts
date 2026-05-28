import { existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import Database from 'better-sqlite3';
import { DEFAULT_CONFIG } from '../config/types.js';
import { ensureUsageColumns, recordUsage } from '../governance/health-monitor.js';
import { shouldBypassExternalModelsInTests } from '../utils/test-runtime.js';
import { createEmbeddingProvider } from '../embedding/create-provider.js';
import { readEmbeddingConfig, checkEmbeddingHealth, EmbeddingUnreachableError, EmbeddingNotConfiguredError, EmbeddingModelNotLoadedError } from '../embedding/health-check.js';

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

  // Vector search — the only search path in production
  const vectorResults = await tryVectorSearch(resolvedDb, queryText, filters);
  if (vectorResults) {
    trackUsageFromResults(resolvedDb, vectorResults.ids);
    return vectorResults.text;
  }

  // In test environments without real models, use in-memory content match
  if (shouldBypassExternalModelsInTests()) {
    const ftsResult = testFallbackSearch(resolvedDb, queryText);
    if (ftsResult.ids.length > 0) {
      trackUsageFromResults(resolvedDb, ftsResult.ids);
    }
    return ftsResult.text;
  }

  // Vector search unavailable or no results — throw with guidance
  const reason = await detectVectorSearchUnavailableReason(resolvedDb);
  if (reason) {
    throw new Error(
      `KIVO 向量检索不可用：${reason}\n` +
      "请确认 embedding provider 已配置且服务已启动。\n" +
      "运行 'kivo init' 进行配置，或手动设置 embedding.provider / embedding.model / embedding.baseUrl\n" +
      "推荐方案: ollama serve && ollama pull bge-m3"
    );
  }

  return `No results for "${queryText}".`;
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
 * FR-B02: Detect why vector search is unavailable and return a user-friendly message.
 * Returns null if vector search should be working (meaning no results matched).
 * Checks: 1) DB has embedding column with data, 2) embedding provider is reachable.
 */
async function detectVectorSearchUnavailableReason(dbPath: string): Promise<string | null> {
  try {
    const db = new Database(dbPath, { readonly: true });
    const columns = db.prepare('PRAGMA table_info(entries)').all() as Array<{ name: string }>;
    const hasEmbedding = columns.some(c => c.name === 'embedding');
    if (!hasEmbedding) {
      db.close();
      return '向量化未完成，当前使用关键词搜索。执行 npx kivo embed-backfill 启用语义搜索。';
    }
    const embCount = (db.prepare('SELECT COUNT(*) as cnt FROM entries WHERE embedding IS NOT NULL').get() as { cnt: number }).cnt;
    db.close();
    if (embCount === 0) {
      return '向量化未完成，当前使用关键词搜索。执行 npx kivo embed-backfill 启用语义搜索。';
    }
  } catch {
    return null;
  }

  // DB has embeddings — check if provider is reachable
  try {
    await checkEmbeddingHealth();
  } catch (err) {
    if (err instanceof EmbeddingUnreachableError) {
      return `Embedding provider 不可达：${err.message}`;
    }
    if (err instanceof EmbeddingNotConfiguredError) {
      return `Embedding provider 未配置：${err.message}`;
    }
    if (err instanceof EmbeddingModelNotLoadedError) {
      return `Embedding 模型未加载：${err.message}`;
    }
    return `Embedding provider 异常：${err instanceof Error ? err.message : String(err)}`;
  }

  return null;
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

    const config = readEmbeddingConfig();
    const provider = createEmbeddingProvider(config);

    const { VectorStore } = await import('../search/vector-store.js');
    const vectorStore = new VectorStore({ dbPath });

    const queryVector = await provider.embed(queryText);
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

/** In-memory content search — used only in test environments as fallback */
function testFallbackSearch(dbPath: string, queryText: string): { text: string; ids: string[] } {
  const db = new Database(dbPath, { readonly: true });
  try {
    const allRows = db.prepare(`
      SELECT id, type, title, content, confidence, tags_json
      FROM entries
      ORDER BY confidence DESC
      LIMIT 100
    `).all() as Array<{ id: string; type: string; title: string; content: string; confidence: number; tags_json: string }>;
    db.close();

    // Match: full query or any 2-char CJK substring or ASCII words
    const searchTerms = [queryText.toLowerCase()];
    const cjk = queryText.replace(/[^\u4e00-\u9fff]/g, '');
    for (let i = 0; i < cjk.length - 1; i++) {
      searchTerms.push(cjk.slice(i, i + 2));
    }
    const words = queryText.match(/[a-zA-Z0-9]+/g) ?? [];
    searchTerms.push(...words.filter(w => w.length >= 2).map(w => w.toLowerCase()));

    const matched = allRows.filter(row => {
      const haystack = `${row.title} ${row.content} ${row.tags_json}`.toLowerCase();
      return searchTerms.some(term => haystack.includes(term));
    }).slice(0, 5);

    if (matched.length === 0) {
      return { text: `No results for "${queryText}".`, ids: [] };
    }

    const lines: string[] = [`Found ${matched.length} result(s) for "${queryText}":\n`];
    for (const row of matched) {
      const tags = JSON.parse(row.tags_json) as string[];
      lines.push(`[${row.type}] ${row.title}`);
      lines.push(`  ${row.content.slice(0, 120)}${row.content.length > 120 ? '...' : ''}`);
      lines.push(`  confidence: ${row.confidence}  tags: ${tags.join(', ')}`);
      lines.push('');
    }
    return { text: lines.join('\n'), ids: matched.map(r => r.id) };
  } catch {
    db.close();
    return { text: `No results for "${queryText}".`, ids: [] };
  }
}
