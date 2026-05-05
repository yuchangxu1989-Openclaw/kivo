/**
 * kivo cron — Incremental knowledge ingestion for crontab use.
 *
 * Tracks file modification times in kivo_meta table. On each run, only
 * processes files that changed since the last run. Use --full to force
 * a complete re-ingest.
 *
 * Uses BGE embedding + LLM semantic extraction (same as `kivo ingest`).
 * Requires OPENAI_API_KEY or models.providers.penguin-main in openclaw.json.
 *
 * Usage: kivo cron [--json] [--full]
 * Designed for crontab, e.g.:
 *   0,30 * * * * cd /root/.openclaw/workspace && npx kivo cron
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join, basename, relative } from 'node:path';
import Database from 'better-sqlite3';
import { MergeDetector } from '../pipeline/merge-detector.js';
import { KnowledgeRepository } from '../repository/index.js';
import { SQLiteProvider } from '../repository/index.js';
import { DEFAULT_CONFIG } from '../config/types.js';
import { runIngestCore } from './ingest-core.js';

export interface CronOptions {
  /** Output JSON */
  json?: boolean;
  /** Force full re-ingest (ignore stored mtimes) */
  full?: boolean;
  /** Skip FR-N05 quality gate */
  noQualityGate?: boolean;
}

const SCAN_FILES = ['AGENTS.md', 'SOUL.md', 'USER.md'];
const SCAN_DIRS = ['memory'];
const META_KEY_PREFIX = 'cron:mtime:';
const EXCLUDED_DIRS = new Set(['node_modules', '.git', 'dist', '.next']);

function resolveDbPath(dir: string): string {
  const configPath = join(dir, 'kivo.config.json');
  let dbPath = process.env.KIVO_DB_PATH ?? String(DEFAULT_CONFIG.dbPath);
  if (!process.env.KIVO_DB_PATH && existsSync(configPath)) {
    const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
    if (typeof raw.dbPath === 'string') dbPath = raw.dbPath;
  }
  return resolve(dir, dbPath);
}

/** Recursively collect .md files from a directory, excluding common non-content dirs */
function collectMdFromDirRecursive(dirPath: string): string[] {
  const result: string[] = [];
  if (!existsSync(dirPath) || !statSync(dirPath).isDirectory()) return result;
  for (const entry of readdirSync(dirPath)) {
    const full = join(dirPath, entry);
    const stat = statSync(full);
    if (stat.isFile() && entry.endsWith('.md')) {
      result.push(full);
    } else if (stat.isDirectory() && !EXCLUDED_DIRS.has(entry)) {
      result.push(...collectMdFromDirRecursive(full));
    }
  }
  return result;
}

function collectAllMdFiles(dir: string): string[] {
  const result: string[] = [];
  const seen = new Set<string>();

  const add = (p: string) => {
    const resolved = resolve(p);
    if (!seen.has(resolved) && existsSync(resolved) && statSync(resolved).isFile()) {
      seen.add(resolved);
      result.push(resolved);
    }
  };

  for (const name of SCAN_FILES) {
    add(join(dir, name));
  }

  for (const f of collectMdFromDirRecursive(dir)) {
    add(f);
  }

  for (const subdir of SCAN_DIRS) {
    const fullDir = resolve(dir, subdir);
    for (const f of collectMdFromDirRecursive(fullDir)) {
      add(f);
    }
  }

  return result;
}

function getStoredMtime(db: Database.Database, fileKey: string): number {
  const row = db.prepare('SELECT value FROM kivo_meta WHERE key = ?').get(META_KEY_PREFIX + fileKey) as { value: string } | undefined;
  return row ? Number(row.value) : 0;
}

function setStoredMtime(db: Database.Database, fileKey: string, mtime: number): void {
  db.prepare(
    `INSERT INTO kivo_meta (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(META_KEY_PREFIX + fileKey, String(mtime));
}

export async function runCron(options: CronOptions = {}): Promise<string> {
  const dir = resolve(process.cwd());
  const dbPath = resolveDbPath(dir);

  if (!existsSync(dbPath)) {
    const msg = 'Database not found. Run `kivo init` first.';
    return options.json ? JSON.stringify({ error: msg }) : `✗ ${msg}`;
  }

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  const allFiles = collectAllMdFiles(dir);
  const changedFiles: Array<{ path: string; mtime: number }> = [];

  for (const filePath of allFiles) {
    const relPath = relative(dir, filePath) || basename(filePath);
    const stat = statSync(filePath);
    const currentMtime = stat.mtimeMs;

    if (options.full) {
      changedFiles.push({ path: filePath, mtime: currentMtime });
    } else {
      const storedMtime = getStoredMtime(db, relPath);
      if (currentMtime > storedMtime) {
        changedFiles.push({ path: filePath, mtime: currentMtime });
      }
    }
  }

  if (changedFiles.length === 0) {
    db.close();
    const msg = 'No changed files detected.';
    return options.json ? JSON.stringify({ changed: 0, extracted: 0 }) : `✓ ${msg}`;
  }

  console.log(`Cron: scanning ${changedFiles.length} changed files`);

  try {
    const mdFiles = changedFiles.map(f => f.path);
    const result = await runIngestCore({ dir, dbPath, mdFiles, json: options.json, noQualityGate: !!options.noQualityGate });

    // Update stored mtimes after successful processing
    for (const { path: filePath, mtime } of changedFiles) {
      const relPath = relative(dir, filePath) || basename(filePath);
      setStoredMtime(db, relPath, mtime);
    }
    db.close();

    const summary = `✓ Cron: ${result.extracted} entries from ${changedFiles.length} changed files` +
      (result.deduped > 0 ? ` (${result.deduped} deduped by vector similarity)` : '') +
      (result.skipped > 0 ? ` (${result.skipped} skipped)` : '');

    console.log(`Ingested total ${result.extracted} entries`);

    // Run merge detection on recently ingested entries
    let mergeCount = 0;
    if (result.extracted > 0) {
      try {
        const provider = new SQLiteProvider({ dbPath });
        const repo = new KnowledgeRepository(provider);
        const allEntries = await repo.findAll();
        const activeEntries = allEntries.filter(e => e.status === 'active');

        // P2-04 fix: get recent entries by sorting on updatedAt descending
        const sortedByRecent = [...activeEntries].sort(
          (a, b) => b.updatedAt.getTime() - a.updatedAt.getTime()
        );
        const recentEntries = sortedByRecent.slice(0, result.extracted);

        // P1-01 fix: pass queryExisting to detect new-vs-existing duplicates
        const existingEntries = activeEntries.filter(
          e => !recentEntries.some(r => r.id === e.id)
        );
        const detector = new MergeDetector({
          similarityThreshold: 0.7,
          queryExisting: async (entry) => existingEntries.filter(e => e.id !== entry.id),
        });

        const candidates = await detector.detect(recentEntries);
        mergeCount = candidates.length;

        if (candidates.length > 0) {
          console.log(`Merge detection: ${candidates.length} candidates found`);
          for (const c of candidates.slice(0, 5)) {
            console.log(`  ${c.reason}`);
          }
        }

        await repo.close();
      } catch (err) {
        console.error(`Merge detection failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (options.json) {
      return JSON.stringify({ changed: changedFiles.length, extracted: result.extracted, deduped: result.deduped, mergeCandidates: mergeCount, details: result.details });
    }

    const lines = [summary];
    if (mergeCount > 0) {
      lines.push(`  ⚠ ${mergeCount} merge candidates detected`);
    }
    lines.push(...result.details);
    return lines.join('\n');
  } catch (err) {
    db.close();
    const msg = err instanceof Error ? err.message : String(err);
    return options.json ? JSON.stringify({ error: msg }) : `✗ ${msg}`;
  }
}
