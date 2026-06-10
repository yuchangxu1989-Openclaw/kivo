#!/usr/bin/env -S npx tsx
/**
 * Mark KIVO rows whose why field duplicates the description/content field.
 *
 * The script is intentionally non-generative: it only flags rows for manual or
 * LLM repair by adding metadata_json.whyDuplicateNeedsReview=true and nulling
 * the duplicate why display value. It never invents a replacement reason.
 */

import Database from 'better-sqlite3';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

interface Options {
  dbPath: string;
  backupDir: string;
  dryRun: boolean;
}

interface DuplicateRow {
  tableName: 'entries' | 'intents';
  id: string;
  title: string;
  description: string;
  why: string;
  metadata_json?: string | null;
}

const DEFAULT_DB_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'kivo.db');
const DEFAULT_BACKUP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'backups', 'why-duplicates');

function parseArgs(argv: string[]): Options {
  const options: Options = { dbPath: DEFAULT_DB_PATH, backupDir: DEFAULT_BACKUP_DIR, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--db') {
      options.dbPath = resolve(argv[++i] ?? '');
    } else if (arg === '--backup-dir') {
      options.backupDir = resolve(argv[++i] ?? '');
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log('Usage: tsx scripts/mark-duplicate-why.ts [--db <path>] [--backup-dir <path>] [--dry-run]');
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function ensureWhyColumns(db: Database.Database): void {
  const entryColumns = db.prepare('PRAGMA table_info(entries)').all() as Array<{ name: string }>;
  if (!entryColumns.some((column) => column.name === 'why')) db.exec('ALTER TABLE entries ADD COLUMN why TEXT');

  const intentColumns = db.prepare('PRAGMA table_info(intents)').all() as Array<{ name: string }>;
  if (intentColumns.length > 0 && !intentColumns.some((column) => column.name === 'why')) {
    db.exec('ALTER TABLE intents ADD COLUMN why TEXT');
  }
}

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function parseMetadata(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function markMetadata(raw: string | null | undefined, source: string, description: string): string {
  const metadata = parseMetadata(raw);
  const domainData = metadata.domainData;
  if (domainData && typeof domainData === 'object' && !Array.isArray(domainData)) {
    const nextDomainData = { ...(domainData as Record<string, unknown>) };
    if (typeof nextDomainData.why === 'string' && normalizeText(nextDomainData.why) === normalizeText(description)) {
      delete nextDomainData.why;
    }
    metadata.domainData = nextDomainData;
  }

  return JSON.stringify({
    ...metadata,
    whyDuplicateNeedsReview: true,
    whyDuplicateMarkedAt: new Date().toISOString(),
    whyDuplicateSource: source,
  });
}

function findDuplicateRows(db: Database.Database): DuplicateRow[] {
  ensureWhyColumns(db);
  const rows: DuplicateRow[] = [];
  rows.push(...db.prepare(`
    SELECT 'entries' AS tableName, id, title, content AS description, why, metadata_json
    FROM entries
    WHERE why IS NOT NULL AND trim(why) <> '' AND trim(why) = trim(content)
  `).all() as DuplicateRow[]);
  rows.push(...db.prepare(`
    SELECT 'intents' AS tableName, id, name AS title, description, why, NULL AS metadata_json
    FROM intents
    WHERE why IS NOT NULL AND trim(why) <> '' AND trim(why) = trim(description)
  `).all() as DuplicateRow[]);
  return rows.filter((row) => normalizeText(row.why) === normalizeText(row.description));
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  if (!existsSync(options.dbPath)) throw new Error(`Database not found: ${options.dbPath}`);

  const db = new Database(options.dbPath);
  try {
    const duplicates = findDuplicateRows(db);
    mkdirSync(options.backupDir, { recursive: true });
    const backupPath = resolve(options.backupDir, `duplicate-why-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    writeFileSync(backupPath, JSON.stringify({ dryRun: options.dryRun, count: duplicates.length, rows: duplicates }, null, 2));

    if (!options.dryRun && duplicates.length > 0) {
      const updateEntry = db.prepare('UPDATE entries SET why = NULL, metadata_json = ?, updated_at = ? WHERE id = ?');
      const updateIntent = db.prepare('UPDATE intents SET why = NULL, updated_at = ? WHERE id = ?');
      const now = new Date().toISOString();
      const txn = db.transaction((rows: DuplicateRow[]) => {
        for (const row of rows) {
          if (row.tableName === 'entries') {
            updateEntry.run(markMetadata(row.metadata_json, 'entries.why=content', row.description), now, row.id);
          } else {
            updateIntent.run(now, row.id);
          }
        }
      });
      txn(duplicates);
    }

    console.log(`${options.dryRun ? '[dry-run] ' : ''}duplicate why rows: ${duplicates.length}`);
    console.log(`backup: ${backupPath}`);
  } finally {
    db.close();
  }
}

main();
