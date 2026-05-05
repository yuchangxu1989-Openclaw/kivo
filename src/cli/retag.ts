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
import type { KnowledgeNature, KnowledgeFunction } from '../types/index.js';

const VALID_NATURES = new Set(['fact', 'concept', 'rule', 'procedure', 'heuristic']);
const VALID_FUNCTIONS = new Set(['routing', 'quality_gate', 'context_enrichment', 'decision_support', 'correction']);

const NATURE_TO_TYPE: Record<string, string> = {
  fact: 'fact',
  concept: 'fact',
  rule: 'intent',
  procedure: 'methodology',
  heuristic: 'experience',
};

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

function buildRetagPrompt(entries: Array<{ id: string; title: string; content: string; type: string }>): string {
  const items = entries.map((e, i) => `[${i}] type=${e.type} title="${e.title}"\n${e.content.slice(0, 300)}`).join('\n\n');

  return `对以下知识条目打三维标签。

三维标签定义：
1. nature（知识本质）: fact / concept / rule / procedure / heuristic
2. function（知识用途）: routing / quality_gate / context_enrichment / decision_support / correction
3. domain（知识领域）: 开放标签，如 "agent-scheduling"、"product-design"、"code-quality"

输出纯 JSON 数组，每条格式：
{"index":<序号>,"nature":"<nature>","function":"<function>","domain":"<domain>"}

知识条目：
${items}`;
}

interface TagResult {
  index: number;
  nature: string;
  function: string;
  domain: string;
}

function parseLlmTags(raw: string): TagResult[] {
  let cleaned = raw.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }
  try {
    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item: unknown) =>
        typeof item === 'object' && item !== null && typeof (item as Record<string, unknown>).index === 'number',
    ) as TagResult[];
  } catch {
    return [];
  }
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
  let sql = 'SELECT id, type, title, content FROM entries WHERE (nature IS NULL OR function_tag IS NULL OR knowledge_domain IS NULL)';
  const params: (string | number)[] = [];
  if (domain) {
    sql += ' AND knowledge_domain = ?';
    params.push(domain);
  }
  if (limit && limit > 0) {
    sql += ' LIMIT ?';
    params.push(limit);
  }
  const rows = db.prepare(sql).all(...params) as Array<{ id: string; type: string; title: string; content: string }>;

  const result: RetagResult = { total: rows.length, retagged: 0, skipped: 0, errors: [], changes: [] };

  if (rows.length === 0) {
    db.close();
    return json
      ? JSON.stringify(result, null, 2)
      : 'All entries already have multi-dimensional tags. Nothing to retag.';
  }

  // Process in batches of 10
  const BATCH_SIZE = 10;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const prompt = buildRetagPrompt(batch);

    try {
      console.log(`Retagging batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(rows.length / BATCH_SIZE)} (${batch.length} entries)...`);
      const rawResponse = await llm.complete(prompt);
      const tags = parseLlmTags(rawResponse);

      for (const tag of tags) {
        if (tag.index < 0 || tag.index >= batch.length) continue;
        const entry = batch[tag.index];
        const nature = VALID_NATURES.has(tag.nature) ? tag.nature : null;
        const functionTag = VALID_FUNCTIONS.has(tag.function) ? tag.function : null;
        const domain = tag.domain || null;

        result.changes.push({
          id: entry.id,
          title: entry.title,
          nature,
          functionTag,
          knowledgeDomain: domain,
        });

        if (!dryRun) {
          db.prepare(
            'UPDATE entries SET nature = ?, function_tag = ?, knowledge_domain = ?, updated_at = ? WHERE id = ?',
          ).run(nature, functionTag, domain, new Date().toISOString(), entry.id);
        }
        result.retagged++;
      }

      // Entries not in LLM response
      const taggedIndices = new Set(tags.map(t => t.index));
      for (let j = 0; j < batch.length; j++) {
        if (!taggedIndices.has(j)) result.skipped++;
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
