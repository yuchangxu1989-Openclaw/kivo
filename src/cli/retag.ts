/**
 * CLI: kivo retag (FR-B05 AC3, AC7)
 *
 * Re-tags existing knowledge entries that lack multi-dimensional tags
 * (nature/function_tag/knowledge_domain) using LLM.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import Database from 'better-sqlite3';
import { DEFAULT_CONFIG } from '../config/types.js';
import { resolveLlmConfig } from './resolve-llm-config.js';
import { OpenAILLMProvider } from '../extraction/llm-extractor.js';
import type { KnowledgeEntry } from '../types/index.js';
import { MultiDimTagger, toKnowledgeEntryPatch } from '../tagging/multi-dim-tagger.js';

export interface RetagOptions {
  dryRun?: boolean;
  limit?: number;
  json?: boolean;
  domain?: string;
}

interface RetagResult {
  total: number;
  retagged: number;
  skipped: number;
  errors: string[];
  changes: Array<{
    id: string;
    title: string;
    nature: string | null;
    functionTag: string | null;
    knowledgeDomain: string | null;
  }>;
}

export async function runRetag(options: RetagOptions = {}): Promise<string> {
  const { dryRun = false, limit, json = false, domain } = options;

  const dir = process.cwd();
  const configPath = join(dir, 'kivo.config.json');
  let dbPath = String(DEFAULT_CONFIG.dbPath);
  if (existsSync(configPath)) {
    const cfg = JSON.parse(readFileSync(configPath, 'utf-8'));
    if (typeof cfg.dbPath === 'string') dbPath = cfg.dbPath;
  }
  const resolvedDb = resolve(dir, dbPath);
  if (!existsSync(resolvedDb)) {
    return 'Database not found. Run "kivo init" first.';
  }

  // Resolve LLM
  const llmConfig = resolveLlmConfig();
  if ('error' in llmConfig) {
    return `LLM config error: ${llmConfig.error}`;
  }
  const llm = new OpenAILLMProvider({
    apiKey: llmConfig.apiKey,
    baseUrl: llmConfig.baseUrl,
    model: llmConfig.model,
    timeoutMs: 120_000,
  });

  const db = new Database(resolvedDb);

  // Ensure columns exist
  const columns = db.prepare('PRAGMA table_info(entries)').all() as Array<{ name: string }>;
  const colNames = new Set(columns.map(c => c.name));
  if (!colNames.has('nature')) db.exec('ALTER TABLE entries ADD COLUMN nature TEXT');
  if (!colNames.has('function_tag')) db.exec('ALTER TABLE entries ADD COLUMN function_tag TEXT');
  if (!colNames.has('knowledge_domain')) db.exec('ALTER TABLE entries ADD COLUMN knowledge_domain TEXT');

  // Find entries without tags
  let sql = 'SELECT id, type, title, content, summary, source_json, confidence, status, tags_json, domain, version, supersedes, similar_sentences, nature, function_tag, knowledge_domain, created_at, updated_at FROM entries WHERE (nature IS NULL OR function_tag IS NULL OR knowledge_domain IS NULL)';
  const params: (string | number)[] = [];
  if (domain) {
    sql += ' AND knowledge_domain = ?';
    params.push(domain);
  }
  if (limit && limit > 0) {
    sql += ' LIMIT ?';
    params.push(limit);
  }
  const rows = db.prepare(sql).all(...params) as EntryRow[];

  const result: RetagResult = { total: rows.length, retagged: 0, skipped: 0, errors: [], changes: [] };

  if (rows.length === 0) {
    db.close();
    return json
      ? JSON.stringify(result, null, 2)
      : 'All entries already have multi-dimensional tags. Nothing to retag.';
  }

  const tagger = new MultiDimTagger({ llm, batchSize: 10 });
  const entries = rows.map(rowToEntry);
  const BATCH_SIZE = 10;
  for (let i = 0; i < entries.length; i += BATCH_SIZE) {
    const batch = entries.slice(i, i + BATCH_SIZE);

    try {
      console.log(`Retagging batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(entries.length / BATCH_SIZE)} (${batch.length} entries)...`);
      const tagged = await tagger.batchRetag(batch);
      const taggedIds = new Set<string>();

      for (const item of tagged) {
        const patch = toKnowledgeEntryPatch(item.tags);
        taggedIds.add(item.entry.id);
        result.changes.push({
          id: item.entry.id,
          title: item.entry.title,
          nature: item.tags.nature,
          functionTag: item.tags.function,
          knowledgeDomain: item.tags.domain,
        });

        if (!dryRun) {
          db.prepare(
            'UPDATE entries SET nature = ?, function_tag = ?, knowledge_domain = ?, updated_at = ? WHERE id = ?',
          ).run(patch.nature, patch.functionTag, patch.knowledgeDomain, new Date().toISOString(), item.entry.id);
        }
        result.retagged++;
      }

      for (const entry of batch) {
        if (!taggedIds.has(entry.id)) result.skipped++;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`Batch ${Math.floor(i / BATCH_SIZE) + 1}: ${msg}`);
      result.skipped += batch.length;
    }
  }

  db.close();

  if (json) {
    return JSON.stringify(result, null, 2);
  }

  // Human-readable output
  const lines: string[] = [];
  lines.push(dryRun ? '=== Retag Preview (DRY RUN) ===' : '=== Retag Results ===');
  lines.push(`Total untagged:  ${result.total}`);
  lines.push(`Retagged:        ${result.retagged}`);
  lines.push(`Skipped:         ${result.skipped}`);
  if (result.errors.length > 0) {
    lines.push(`Errors:          ${result.errors.length}`);
    for (const e of result.errors) lines.push(`  ✗ ${e}`);
  }
  if (dryRun && result.changes.length > 0) {
    lines.push('\nPreview of changes:');
    for (const c of result.changes.slice(0, 20)) {
      lines.push(`  ${c.id.slice(0, 8)} "${c.title}" → nature=${c.nature} function=${c.functionTag} domain=${c.knowledgeDomain}`);
    }
    if (result.changes.length > 20) {
      lines.push(`  ... and ${result.changes.length - 20} more`);
    }
  }
  return lines.join('\n');
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
