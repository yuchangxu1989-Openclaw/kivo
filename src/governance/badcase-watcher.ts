import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve, extname, dirname } from 'node:path';
import { DEFAULT_CONFIG } from '../config/types.js';
import { runLearnFromBadcase } from '../cli/cmd-learn-from-badcase.js';
import { resolveLlmConfig } from '../cli/resolve-llm-config.js';

const DEFAULT_INTERVAL_MS = 15_000;
const SUPPORTED_EXTENSIONS = new Set(['.md', '.txt', '.json', '.log']);

export interface WatchBadcasesOptions {
  dir: string;
  stateFile?: string;
  intervalMs?: number;
  once?: boolean;
  json?: boolean;
  cwd?: string;
}

interface WatcherState {
  files: Record<string, number>;
}

interface FileCandidate {
  path: string;
  mtimeMs: number;
}

export interface WatchBadcasesSummary {
  watchDir: string;
  stateFile: string;
  scanned: number;
  processed: number;
  skipped: number;
  llmAvailable: boolean;
  warnings: string[];
  details: Array<{
    file: string;
    status: 'processed' | 'skipped' | 'error';
    message: string;
  }>;
}

function ensureParentDir(filePath: string): void {
  const parent = dirname(filePath);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
}

function loadState(stateFile: string): WatcherState {
  if (!existsSync(stateFile)) return { files: {} };
  try {
    const raw = JSON.parse(readFileSync(stateFile, 'utf-8')) as WatcherState;
    return raw && typeof raw === 'object' && raw.files ? raw : { files: {} };
  } catch {
    return { files: {} };
  }
}

function saveState(stateFile: string, state: WatcherState): void {
  ensureParentDir(stateFile);
  writeFileSync(stateFile, JSON.stringify(state, null, 2) + '\n', 'utf-8');
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

function collectCandidatesRecursive(dirPath: string): FileCandidate[] {
  if (!existsSync(dirPath) || !statSync(dirPath).isDirectory()) return [];

  const result: FileCandidate[] = [];
  for (const entry of readdirSync(dirPath)) {
    const full = join(dirPath, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      result.push(...collectCandidatesRecursive(full));
      continue;
    }
    if (!stat.isFile()) continue;
    if (!SUPPORTED_EXTENSIONS.has(extname(full).toLowerCase())) continue;
    result.push({ path: full, mtimeMs: stat.mtimeMs });
  }
  return result.sort((a, b) => a.mtimeMs - b.mtimeMs);
}

async function processOnce(options: Required<Pick<WatchBadcasesOptions, 'dir' | 'stateFile' | 'cwd'>> & Pick<WatchBadcasesOptions, 'json'>): Promise<WatchBadcasesSummary> {
  const watchDir = resolve(options.dir);
  const stateFile = resolve(options.stateFile);
  const summary: WatchBadcasesSummary = {
    watchDir,
    stateFile,
    scanned: 0,
    processed: 0,
    skipped: 0,
    llmAvailable: !('error' in resolveLlmConfig()),
    warnings: [],
    details: [],
  };

  if (!existsSync(watchDir) || !statSync(watchDir).isDirectory()) {
    summary.warnings.push(`Watch directory not found: ${watchDir}`);
    return summary;
  }

  const llmConfig = resolveLlmConfig();
  summary.llmAvailable = !('error' in llmConfig);

  if (!summary.llmAvailable) {
    summary.warnings.push((llmConfig as { error: string }).error);
    summary.warnings.push('LLM unavailable; badcase watcher skipped.');
    return summary;
  }

  const dbPath = resolveDbPath(options.cwd);
  if (!existsSync(dbPath)) {
    summary.warnings.push(`Database not found at ${dbPath}. Run \`kivo init\` first.`);
    return summary;
  }

  const state = loadState(stateFile);
  const files = collectCandidatesRecursive(watchDir);
  summary.scanned = files.length;

  for (const file of files) {
    const previousMtime = state.files[file.path] ?? 0;
    if (file.mtimeMs <= previousMtime) {
      summary.skipped++;
      continue;
    }

    try {
      const output = await runLearnFromBadcase({
        source: file.path,
        cwd: options.cwd,
        json: false,
      });
      state.files[file.path] = file.mtimeMs;
      summary.processed++;
      summary.details.push({
        file: file.path,
        status: 'processed',
        message: output.split('\n')[0] ?? 'processed',
      });
    } catch (error) {
      summary.details.push({
        file: file.path,
        status: 'error',
        message: (error as Error).message,
      });
    }
  }

  saveState(stateFile, state);
  return summary;
}

function formatSummary(summary: WatchBadcasesSummary): string {
  const lines: string[] = [];
  lines.push('═══ KIVO Badcase Watcher ═══');
  lines.push(`Watch dir: ${summary.watchDir}`);
  lines.push(`State file: ${summary.stateFile}`);
  lines.push(`LLM: ${summary.llmAvailable ? 'available' : 'unavailable'}`);
  lines.push(`Scanned: ${summary.scanned}`);
  lines.push(`Processed: ${summary.processed}`);
  lines.push(`Skipped: ${summary.skipped}`);
  if (summary.warnings.length > 0) {
    lines.push('Warnings:');
    for (const warning of summary.warnings) lines.push(`  - ${warning}`);
  }
  if (summary.details.length > 0) {
    lines.push('Details:');
    for (const item of summary.details) {
      lines.push(`  - [${item.status}] ${item.file}: ${item.message}`);
    }
  }
  return lines.join('\n');
}

export async function runWatchBadcases(options: WatchBadcasesOptions): Promise<string> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const watchDir = resolve(options.dir);
  const stateFile = resolve(options.stateFile ?? join(cwd, '.kivo', 'badcase-watcher-state.json'));
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;

  const run = () => processOnce({ dir: watchDir, stateFile, cwd, json: options.json });

  if (options.once) {
    const summary = await run();
    return options.json ? JSON.stringify(summary, null, 2) : formatSummary(summary);
  }

  console.log(`Watching badcases in ${watchDir} (interval=${intervalMs}ms)`);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const summary = await run();
    console.log(options.json ? JSON.stringify(summary) : formatSummary(summary));
    await new Promise(resolveDelay => setTimeout(resolveDelay, intervalMs));
  }
}
