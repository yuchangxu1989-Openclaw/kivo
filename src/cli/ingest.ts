/**
 * kivo ingest — Scan markdown files and extract knowledge entries into the DB.
 *
 * Uses BGE embedding + LLM semantic extraction to parse markdown
 * sections, classify them into 6 knowledge types, and persist to SQLite.
 *
 * Requires OPENAI_API_KEY or models.providers.penguin-main in openclaw.json.
 *
 * Default scan targets: all .md files in the working directory + memory/*.md.
 * AGENTS.md, SOUL.md, USER.md are scanned first (priority), then remaining .md files.
 * Custom directories/files can be passed via options.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join, basename, relative } from 'node:path';
import { DEFAULT_CONFIG } from '../config/types.js';
import { runIngestCore } from './ingest-core.js';

export interface IngestOptions {
  /** Working directory (defaults to cwd) */
  cwd?: string;
  /** Additional directories to scan */
  dirs?: string[];
  /** Additional specific files to ingest */
  files?: string[];
  /** Whether to output JSON */
  json?: boolean;
  /** @deprecated LLM extraction is now always used. This flag is kept for backward compatibility but has no effect. */
  llm?: boolean;
  /** Skip FR-N05 quality gate */
  noQualityGate?: boolean;
}

/** Default workspace files to scan */
const DEFAULT_SCAN_FILES = [
  'AGENTS.md',
  'SOUL.md',
  'USER.md',
];

const DEFAULT_SCAN_DIRS = [
  'memory',
];

function resolveDbPath(dir: string): string {
  const configPath = join(dir, 'kivo.config.json');
  let dbPath = process.env.KIVO_DB_PATH ?? String(DEFAULT_CONFIG.dbPath);
  if (!process.env.KIVO_DB_PATH && existsSync(configPath)) {
    const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
    if (typeof raw.dbPath === 'string') dbPath = raw.dbPath;
  }
  return resolve(dir, dbPath);
}

/** Directories to skip during recursive scan */
const EXCLUDED_DIRS = new Set(['node_modules', '.git', 'dist', '.next']);

/** Recursively collect .md files from a directory */
function collectMdFromDir(dirPath: string): string[] {
  const result: string[] = [];
  if (!existsSync(dirPath) || !statSync(dirPath).isDirectory()) return result;
  for (const entry of readdirSync(dirPath)) {
    const full = join(dirPath, entry);
    const stat = statSync(full);
    if (stat.isFile() && entry.endsWith('.md')) {
      result.push(full);
    } else if (stat.isDirectory() && !EXCLUDED_DIRS.has(entry)) {
      result.push(...collectMdFromDir(full));
    }
  }
  return result;
}

function collectMarkdownFiles(baseDir: string, extraDirs?: string[], extraFiles?: string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();

  const add = (p: string) => {
    const resolved = resolve(p);
    if (!seen.has(resolved) && existsSync(resolved) && statSync(resolved).isFile()) {
      seen.add(resolved);
      result.push(resolved);
    }
  };

  // When --files is provided, ONLY scan those specific files (exclusive mode)
  if (extraFiles && extraFiles.length > 0) {
    for (const f of extraFiles) {
      const resolved = resolve(baseDir, f);
      if (resolved.endsWith('.md')) add(resolved);
    }
    return result;
  }

  // Default scan: top-level files (named priorities first)
  for (const name of DEFAULT_SCAN_FILES) {
    add(join(baseDir, name));
  }

  // All .md files in the base directory (catches any markdown file)
  for (const f of collectMdFromDir(baseDir)) {
    add(f);
  }

  // Default subdirectories
  for (const subdir of DEFAULT_SCAN_DIRS) {
    for (const f of collectMdFromDir(join(baseDir, subdir))) {
      add(f);
    }
  }

  // Extra directories
  if (extraDirs) {
    for (const d of extraDirs) {
      for (const f of collectMdFromDir(resolve(baseDir, d))) {
        add(f);
      }
    }
  }

  return result;
}

export async function runIngest(options: IngestOptions = {}): Promise<string> {
  const dir = resolve(options.cwd ?? process.cwd());
  const dbPath = resolveDbPath(dir);

  if (!existsSync(dbPath)) {
    return options.json
      ? JSON.stringify({ error: 'Database not found. Run `kivo init` first.', path: dbPath })
      : `✗ Database not found at ${dbPath}. Run \`kivo init\` first.`;
  }

  const mdFiles = collectMarkdownFiles(dir, options.dirs, options.files);
  if (mdFiles.length === 0) {
    return options.json
      ? JSON.stringify({ error: 'No markdown files found to ingest.', dir })
      : `✗ No markdown files found in ${dir}`;
  }

  console.log(`Scanning ${mdFiles.length} markdown files...`);

  try {
    const result = await runIngestCore({ dir, dbPath, mdFiles, json: options.json, noQualityGate: !!options.noQualityGate });

    const summary = `✓ [LLM] Ingested ${result.extracted} knowledge entries from ${result.files} files` +
      (result.deduped > 0 ? ` (${result.deduped} deduped by vector similarity)` : '') +
      (result.skipped > 0 ? ` (${result.skipped} skipped)` : '');

    console.log(`Ingested total ${result.extracted} entries`);

    if (options.json) {
      return JSON.stringify({
        mode: 'llm',
        extracted: result.extracted,
        deduped: result.deduped,
        skipped: result.skipped,
        files: result.files,
        details: result.details,
      });
    }

    return [summary, ...result.details].join('\n');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return options.json ? JSON.stringify({ error: msg }) : `✗ ${msg}`;
  }
}
