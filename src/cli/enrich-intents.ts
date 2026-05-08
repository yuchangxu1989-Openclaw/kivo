/**
 * kivo enrich-intents — Backfill similar_sentences for existing intent entries.
 *
 * Scans DB for type='intent' entries with empty similar_sentences,
 * calls LLM to generate 5~10 paraphrases per entry, writes back to DB.
 *
 * Options:
 *   --dry-run   Preview without writing to DB
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import Database from 'better-sqlite3';
import { DEFAULT_CONFIG } from '../config/types.js';
import { OpenAILLMProvider } from '../extraction/llm-extractor.js';

export interface EnrichIntentsOptions {
  cwd?: string;
  dryRun?: boolean;
  json?: boolean;
  batchSize?: number;
}

function resolveDbPath(dir: string): string {
  const configPath = join(dir, 'kivo.config.json');
  let dbPath = process.env.KIVO_DB_PATH ?? String(DEFAULT_CONFIG.dbPath);
  if (!process.env.KIVO_DB_PATH && existsSync(configPath)) {
    const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
    if (typeof raw.dbPath === 'string') dbPath = raw.dbPath;
  }
  return resolve(dir, dbPath);
}

interface IntentRow {
  id: string;
  title: string;
  content: string;
  similar_sentences: string | null;
}

function buildEnrichPrompt(title: string, content: string): string {
  return `你是一个意图理解专家。给定以下意图知识条目，请生成 5~10 条用户可能说出的、表达同一意图的自然语言句子。

意图标题: ${title}
意图内容: ${content}

要求：
- 生成的句子应该多样化，覆盖不同的表达方式（口语/书面、中文/英文混合、简短/详细）
- 每条句子是独立的用户输入，不是对意图的解释
- 返回纯 JSON 数组，如 ["句子1", "句子2", ...]
- 不要包含 markdown 代码块标记`;
}

function parseSentences(raw: string): string[] {
  let cleaned = raw.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }
  try {
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) {
      return parsed
        .filter((s: unknown) => typeof s === 'string' && s.trim().length > 0)
        .map((s: string) => s.length > 200 ? s.slice(0, 200) : s)
        .slice(0, 15);
    }
    return [];
  } catch {
    return [];
  }
}

export async function runEnrichIntents(options: EnrichIntentsOptions = {}): Promise<string> {
  const dir = resolve(options.cwd ?? process.cwd());
  const dbPath = resolveDbPath(dir);

  if (!existsSync(dbPath)) {
    return options.json
      ? JSON.stringify({ error: 'Database not found. Run `kivo init` first.' })
      : '✗ Database not found. Run `kivo init` first.';
  }

  // Resolve LLM config
  const { resolveLlmConfig } = await import('./resolve-llm-config.js');
  const llmConfig = resolveLlmConfig();
  if ('error' in llmConfig) {
    return options.json
      ? JSON.stringify({ error: llmConfig.error })
      : `✗ ${llmConfig.error}`;
  }

  const db = new Database(dbPath);

  // Check if similar_sentences column exists
  const columns = db.prepare('PRAGMA table_info(entries)').all() as Array<{ name: string }>;
  if (!columns.some(c => c.name === 'similar_sentences')) {
    db.exec(`ALTER TABLE entries ADD COLUMN similar_sentences TEXT DEFAULT '[]'`);
  }

  // Find intent entries with empty similar_sentences
  const rows = db.prepare(`
    SELECT id, title, content, similar_sentences
    FROM entries
    WHERE type = 'intent'
      AND (similar_sentences IS NULL OR similar_sentences = '[]' OR similar_sentences = '')
  `).all() as IntentRow[];

  if (rows.length === 0) {
    db.close();
    return options.json
      ? JSON.stringify({ enriched: 0, message: 'All intent entries already have similar sentences.' })
      : '✓ All intent entries already have similar sentences.';
  }

  const llmProvider = new OpenAILLMProvider({
    apiKey: llmConfig.apiKey,
    baseUrl: llmConfig.baseUrl,
    model: llmConfig.model,
  });

  const results: Array<{ id: string; title: string; sentences: string[] }> = [];
  let enriched = 0;
  let failed = 0;
  const batchSize = options.batchSize ?? 3;

  for (let batchStart = 0; batchStart < rows.length; batchStart += batchSize) {
    const batch = rows.slice(batchStart, batchStart + batchSize);
    if (batchStart > 0) {
      // Inter-batch delay to avoid API rate limiting
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    for (const row of batch) {
      console.log(`Enriching: ${row.title} (${row.id.slice(0, 8)})`);

      try {
        const prompt = buildEnrichPrompt(row.title, row.content);
        const rawResponse = await llmProvider.complete(prompt);
        const sentences = parseSentences(rawResponse);

        if (sentences.length === 0) {
          console.log(`  ⚠ No sentences generated, skipping`);
          failed++;
          continue;
        }

        results.push({ id: row.id, title: row.title, sentences });

        if (!options.dryRun) {
          const now = new Date().toISOString();
          db.prepare('UPDATE entries SET similar_sentences = ?, updated_at = ? WHERE id = ?')
            .run(JSON.stringify(sentences), now, row.id);
        }

        enriched++;
        console.log(`  ✓ ${sentences.length} sentences${options.dryRun ? ' (dry-run)' : ''}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`  ✗ Failed: ${msg}`);
        failed++;
      }
    }
  }

  db.close();

  if (options.json) {
    return JSON.stringify({ enriched, failed, total: rows.length, dryRun: !!options.dryRun, results });
  }

  const lines: string[] = [];
  lines.push(`${options.dryRun ? '[DRY-RUN] ' : ''}✓ Enriched ${enriched}/${rows.length} intent entries${failed > 0 ? ` (${failed} failed)` : ''}`);
  if (options.dryRun) {
    for (const r of results) {
      lines.push(`  ${r.title}: ${r.sentences.join(' | ')}`);
    }
  }
  return lines.join('\n');
}
