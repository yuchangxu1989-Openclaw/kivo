#!/usr/bin/env -S npx tsx
/**
 * Rebuild truncated KIVO entry titles.
 *
 * Scans entries whose title ends with "...", backs them up, asks the configured
 * LLM for complete readable titles no longer than 20 characters, and writes the
 * repaired titles back to kivo.db.
 */

import Database from 'better-sqlite3';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OpenAILLMProvider } from '../src/extraction/llm-extractor.js';
import { resolveLlmConfig } from '../src/cli/resolve-llm-config.js';

interface EntryRow {
  id: string;
  type: string;
  title: string;
  content: string;
  summary: string;
  domain: string | null;
  updated_at: string;
}

interface GeneratedTitle {
  id: string;
  title: string;
}

interface Options {
  dbPath: string;
  backupDir: string;
  dryRun: boolean;
  limit?: number;
}

const TITLE_LIMIT = 20;
const BATCH_SIZE = 10;
const DEFAULT_DB_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'kivo.db');
const DEFAULT_BACKUP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'backups', 'title-fix');

function parseArgs(argv: string[]): Options {
  const options: Options = {
    dbPath: DEFAULT_DB_PATH,
    backupDir: DEFAULT_BACKUP_DIR,
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--db') {
      options.dbPath = resolve(argv[++i] ?? '');
    } else if (arg === '--backup-dir') {
      options.backupDir = resolve(argv[++i] ?? '');
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--limit') {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value <= 0) throw new Error('--limit must be a positive integer');
      options.limit = value;
    } else if (arg === '--help' || arg === '-h') {
      console.log(`Usage: tsx scripts/fix-truncated-titles.ts [options]\n\nOptions:\n  --db <path>           SQLite DB path (default: ./kivo.db)\n  --backup-dir <path>   Backup directory (default: ./backups/title-fix)\n  --dry-run             Create backup and preview, do not update DB\n  --limit <n>           Process at most n entries\n`);
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function sanitizeTitle(raw: string): string {
  let title = raw
    .replace(/^标题[:：]\s*/u, '')
    .replace(/["“”'`]/g, '')
    .replace(/\s+/g, '')
    .trim();

  title = title.replace(/[…。．.!！?？,，:：;；]+$/u, '').trim();
  if (!title) throw new Error('LLM returned an empty title');
  if (title.includes('...') || title.includes('…')) throw new Error(`LLM returned an ellipsis title: ${raw}`);
  if (title.length > TITLE_LIMIT) throw new Error(`LLM returned a title longer than ${TITLE_LIMIT} characters: ${title}`);
  return title;
}

function parseGeneratedTitles(raw: string): GeneratedTitle[] {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```json\s*([\s\S]*?)```/i) ?? trimmed.match(/```\s*([\s\S]*?)```/);
  const jsonText = fenced?.[1]?.trim() ?? trimmed.slice(trimmed.indexOf('['), trimmed.lastIndexOf(']') + 1);
  const parsed = JSON.parse(jsonText) as unknown;
  if (!Array.isArray(parsed)) throw new Error('LLM response must be a JSON array');

  return parsed.map((item) => {
    if (!item || typeof item !== 'object') throw new Error('LLM response item must be an object');
    const record = item as Record<string, unknown>;
    if (typeof record.id !== 'string' || typeof record.title !== 'string') {
      throw new Error('LLM response item must contain string id and title');
    }
    return { id: record.id, title: sanitizeTitle(record.title) };
  });
}

function buildPrompt(entries: EntryRow[]): string {
  const payload = entries.map((entry) => ({
    id: entry.id,
    type: entry.type,
    oldTitle: entry.title,
    content: entry.content.slice(0, 1200),
    summary: entry.summary,
    domain: entry.domain,
  }));

  return `你在修复 KIVO 知识库里被机械截断的标题。请为每条记录重新生成完整、可读、人话的中文短标题。

硬性要求：
- title 必须 ≤20 个字符
- title 不能以省略号结尾，不能包含 ... 或 …
- title 必须是完整短语，不能在词语中间截断
- title 要抽象概括 content/summary 的核心意思，不照搬 oldTitle
- 只返回 JSON 数组，不要 markdown，不要解释
- 输出格式：[{"id":"原 id","title":"新标题"}]

待修复记录：
${JSON.stringify(payload, null, 2)}`;
}

function writeBackup(entries: EntryRow[], backupDir: string): string {
  mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = resolve(backupDir, `truncated-titles-${stamp}.json`);
  writeFileSync(backupPath, JSON.stringify({ createdAt: new Date().toISOString(), entries }, null, 2));
  return backupPath;
}

async function generateTitles(entries: EntryRow[]): Promise<Map<string, string>> {
  const llmConfig = resolveLlmConfig();
  if ('error' in llmConfig) throw new Error(llmConfig.error);

  const llm = new OpenAILLMProvider({
    apiKey: llmConfig.apiKey,
    baseUrl: llmConfig.baseUrl,
    model: llmConfig.model,
    timeoutMs: 90_000,
  });

  const generated = new Map<string, string>();
  for (let start = 0; start < entries.length; start += BATCH_SIZE) {
    const batch = entries.slice(start, start + BATCH_SIZE);
    const raw = await llm.complete(buildPrompt(batch));
    const titles = parseGeneratedTitles(raw);
    const batchIds = new Set(batch.map((entry) => entry.id));

    for (const item of titles) {
      if (!batchIds.has(item.id)) throw new Error(`LLM returned unknown id: ${item.id}`);
      generated.set(item.id, item.title);
    }

    for (const entry of batch) {
      if (!generated.has(entry.id)) throw new Error(`LLM did not return a title for entry ${entry.id}`);
    }
  }
  return generated;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (!existsSync(options.dbPath)) throw new Error(`Database not found: ${options.dbPath}`);

  const db = new Database(options.dbPath);
  try {
    let sql = `SELECT id, type, title, content, summary, domain, updated_at
      FROM entries
      WHERE status = 'active' AND title LIKE '%...'
      ORDER BY created_at ASC`;
    const params: number[] = [];
    if (options.limit) {
      sql += ' LIMIT ?';
      params.push(options.limit);
    }

    const entries = db.prepare(sql).all(...params) as EntryRow[];
    console.log(`Found ${entries.length} truncated titles`);
    if (entries.length === 0) return;

    const backupPath = writeBackup(entries, options.backupDir);
    console.log(`Backup written: ${backupPath}`);

    const generated = await generateTitles(entries);
    const changes = entries.map((entry) => ({
      id: entry.id,
      oldTitle: entry.title,
      newTitle: generated.get(entry.id) ?? entry.title,
    }));

    if (options.dryRun) {
      console.log(JSON.stringify({ dryRun: true, backupPath, changes }, null, 2));
      return;
    }

    const update = db.prepare(`UPDATE entries SET title = ?, updated_at = ? WHERE id = ?`);
    const now = new Date().toISOString();
    const txn = db.transaction(() => {
      for (const change of changes) update.run(change.newTitle, now, change.id);
    });
    txn();

    console.log(JSON.stringify({ updated: changes.length, backupPath, changes }, null, 2));
  } finally {
    db.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
