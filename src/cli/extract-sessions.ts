/**
 * CLI: kivo extract-sessions (FR-A05)
 *
 * Extracts knowledge from session history JSONL files via:
 * 1. Python preprocessor (session-knowledge-extractor.py) → candidates JSON
 * 2. LLM extraction → structured knowledge with multi-dimensional tags
 * 3. Write to KIVO DB
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { extractSessionKnowledge } from './session-knowledge-llm.js';
import type { SessionExtractResult } from './session-knowledge-llm.js';
import { DEFAULT_CONFIG } from '../config/types.js';

export type ExtractSource = 'sessions' | 'memory' | 'all';

/**
 * Resolve the OpenClaw workspace root in a portable way.
 * Order: OPENCLAW_WORKSPACE → $HOME/.openclaw/workspace → cwd fallback.
 */
function resolveWorkspaceRoot(): string {
  if (process.env.OPENCLAW_WORKSPACE) {
    return resolve(process.env.OPENCLAW_WORKSPACE);
  }
  const home = process.env.HOME || process.env.USERPROFILE;
  if (home) {
    return join(home, '.openclaw', 'workspace');
  }
  return process.cwd();
}

export interface ExtractSessionsOptions {
  dryRun?: boolean;
  limit?: number;
  since?: string;
  candidates?: string;
  noQualityGate?: boolean;
  source?: ExtractSource;
  full?: boolean;
}

export const EXTRACTION_CHECKPOINT_KEY = 'extract_sessions_checkpoint';

export interface ExtractionCheckpoint {
  lastExtractedAt: string;
}

interface CandidatesMetadata {
  total_messages?: number;
  total_segments?: number;
  after_filter?: number;
  generated_at?: string;
  total_clusters?: number;
}

function resolveDbPath(dir: string): string {
  const configPath = join(dir, 'kivo.config.json');
  let dbPath = process.env.KIVO_DB_PATH ?? String(DEFAULT_CONFIG.dbPath);
  if (!process.env.KIVO_DB_PATH && existsSync(configPath)) {
    const cfg = JSON.parse(readFileSync(configPath, 'utf-8'));
    if (typeof cfg.dbPath === 'string') dbPath = cfg.dbPath;
  }
  return resolve(dir, dbPath);
}

function ensureMetaTable(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS kivo_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
}

export function readExtractionCheckpoint(dbPath: string): ExtractionCheckpoint | undefined {
  if (!existsSync(dbPath)) return undefined;
  const db = new Database(dbPath);
  try {
    ensureMetaTable(db);
    const row = db.prepare('SELECT value FROM kivo_meta WHERE key = ?').get(EXTRACTION_CHECKPOINT_KEY) as { value: string } | undefined;
    if (!row) return undefined;
    const parsed = JSON.parse(row.value) as Partial<ExtractionCheckpoint>;
    return typeof parsed.lastExtractedAt === 'string' ? { lastExtractedAt: parsed.lastExtractedAt } : undefined;
  } finally {
    db.close();
  }
}

export function writeExtractionCheckpoint(dbPath: string, checkpoint: ExtractionCheckpoint): void {
  const db = new Database(dbPath);
  try {
    ensureMetaTable(db);
    db.prepare("INSERT OR REPLACE INTO kivo_meta (key, value, updated_at) VALUES (?, ?, datetime('now'))")
      .run(EXTRACTION_CHECKPOINT_KEY, JSON.stringify(checkpoint));
  } finally {
    db.close();
  }
}

function readCandidatesMetadata(candidatesPath: string): CandidatesMetadata {
  const raw = readFileSync(candidatesPath, 'utf-8');
  const parsed = JSON.parse(raw) as { metadata?: CandidatesMetadata };
  return parsed.metadata ?? {};
}

export function hasCandidateWork(candidatesPath: string): boolean {
  return (readCandidatesMetadata(candidatesPath).total_clusters ?? 0) > 0;
}

export function latestCandidateTimestamp(candidatesPath: string): string | undefined {
  const raw = readFileSync(candidatesPath, 'utf-8');
  const parsed = JSON.parse(raw) as {
    clusters?: Array<{ representative_segments?: Array<{ timestamp?: unknown }> }>;
  };
  let latest: string | undefined;
  for (const cluster of parsed.clusters ?? []) {
    for (const segment of cluster.representative_segments ?? []) {
      if (typeof segment.timestamp === 'string' && (!latest || segment.timestamp > latest)) {
        latest = segment.timestamp;
      }
    }
  }
  return latest;
}
export function shouldPersistExtractionCheckpoint(options: ExtractSessionsOptions, result: SessionExtractResult): boolean {
  if (options.dryRun) return false;
  if (options.candidates) return false;
  if (options.since) return false;
  if (options.limit !== undefined) return false;
  return result.errors.length === 0;
}

/**
 * Check if BGE embedding model is available (FR-A05 AC4: graceful skip).
 * Returns true if available, false otherwise (with a warning printed).
 */
function checkBgeAvailability(): boolean {
  try {
    execSync('python3 -c "import sentence_transformers"', {
      encoding: 'utf-8',
      timeout: 15_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return true;
  } catch {
    console.log('⚠ 会话知识萃取需要向量 embedding 模型（如 BGE），请参考文档配置');
    console.log('  pip install sentence-transformers');
    console.log('  (继续执行，但跳过向量 embedding 步骤)');
    return false;
  }
}

/**
 * Run the Python session-knowledge-extractor.py preprocessor.
 * Returns the path to the generated candidates JSON.
 */
function runPythonPreprocessor(since?: string, sinceTimestamp?: string): string {
  const workspaceRoot = resolveWorkspaceRoot();
  const scriptPath = resolve(workspaceRoot, 'scripts', 'session-knowledge-extractor.py');
  if (!existsSync(scriptPath)) {
    throw new Error(`Python preprocessor not found: ${scriptPath}`);
  }

  const outputPath = resolve(workspaceRoot, 'reports', 'session-knowledge-candidates.json');
  let cmd = `python3 "${scriptPath}"`;
  if (since) {
    cmd += ` --since "${since}"`;
  }
  if (sinceTimestamp) {
    cmd += ` --since-timestamp "${sinceTimestamp}"`;
  }

  console.log('Running session knowledge preprocessor...');
  try {
    execSync(cmd, {
      encoding: 'utf-8',
      timeout: 120_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Python preprocessor failed: ${msg}`);
  }

  if (!existsSync(outputPath)) {
    throw new Error(`Preprocessor did not produce output at ${outputPath}`);
  }

  return outputPath;
}

function formatResult(result: SessionExtractResult, dryRun: boolean): string {
  const lines: string[] = [];
  lines.push(dryRun ? '=== Session Knowledge Extraction (DRY RUN) ===' : '=== Session Knowledge Extraction ===');
  lines.push(`Clusters processed: ${result.clustersProcessed}`);
  lines.push(`Clusters skipped:   ${result.clustersSkipped}`);
  lines.push(`Materials collected: ${result.materialsCollected}`);
  lines.push(`Knowledge extracted: ${result.knowledgeExtracted}`);
  if (!dryRun) {
    lines.push(`Knowledge written:   ${result.knowledgeWritten}`);
    if (result.qualityGate) {
      lines.push('Quality gate:');
      lines.push(`  Total:     ${result.qualityGate.total}`);
      lines.push(`  Passed:    ${result.qualityGate.passed}`);
      lines.push(`  Rejected:  ${result.qualityGate.rejected}`);
      lines.push(`  Merged:    ${result.qualityGate.merged}`);
      lines.push(`  Bypassed:  ${result.qualityGate.bypassed}`);
      const reasons = Object.entries(result.qualityGate.rejectionReasons);
      if (reasons.length > 0) {
        lines.push(`  Rejection reasons: ${reasons.map(([k, v]) => `${k}=${v}`).join(', ')}`);
      }
      if (result.qualityGate.warning) lines.push(`  ⚠ ${result.qualityGate.warning}`);
    }
    if (result.postExtractionQuality) {
      lines.push('Post-extraction quality audit:');
      lines.push(`  Assessed:            ${result.postExtractionQuality.assessed}`);
      lines.push(`  Pending review:      ${result.postExtractionQuality.quarantined}`);
      lines.push(`  Evidence preserved:  ${result.postExtractionQuality.evidencePreserved}`);
    }
  }
  lines.push(`Token estimate:      ~${result.tokenEstimate.toLocaleString()}`);
  if (result.errors.length > 0) {
    lines.push(`\nErrors (${result.errors.length}):`);
    for (const e of result.errors) {
      lines.push(`  ✗ ${e}`);
    }
  }
  return lines.join('\n');
}

export async function runExtractSessions(options: ExtractSessionsOptions = {}): Promise<string> {
  const { dryRun = false, limit, since, candidates, noQualityGate = false, source = 'sessions', full = false } = options;

  // Handle --source memory or --source all
  if (source === 'memory' || source === 'all') {
    const { extractMemoryKnowledge, formatMemoryResult } = await import('./extract-memory.js');
    const outputs: string[] = [];

    if (source === 'all') {
      // Run sessions extraction first
      const sessionsOutput = await runExtractSessionsOnly({ dryRun, limit, since, candidates, noQualityGate, full });
      outputs.push(sessionsOutput);
      outputs.push('');
    }

    // Run memory extraction
    const memoryResult = await extractMemoryKnowledge({ dryRun, limit, noQualityGate });
    outputs.push(formatMemoryResult(memoryResult, dryRun));

    return outputs.join('\n');
  }

  // Default: sessions only
  return runExtractSessionsOnly(options);
}

async function runExtractSessionsOnly(options: ExtractSessionsOptions = {}): Promise<string> {
  const { dryRun = false, limit, since, candidates, noQualityGate = false, full = false } = options;

  // Check preprocessor script existence BEFORE expensive BGE check (avoids loading PyTorch for nothing)
  if (!candidates) {
    const scriptPath = resolve(resolveWorkspaceRoot(), 'scripts', 'session-knowledge-extractor.py');
    if (!existsSync(scriptPath)) {
      console.log('ℹ Python 预处理脚本不存在，跳过会话知识萃取。');
      console.log(`  预期路径: ${scriptPath}`);
      console.log('  或使用 --candidates 参数提供已有的候选文件。');
      return 'Skipped: Python preprocessor script not found. Use --candidates to provide pre-built candidates.';
    }

    // FR-A05 AC4: graceful skip if BGE not available and no pre-built candidates
    const bgeAvailable = checkBgeAvailability();
    if (!bgeAvailable) {
      console.log('ℹ BGE embedding 模型不可用，跳过会话知识萃取。');
      console.log('  如需使用，请先安装：pip install sentence-transformers');
      console.log('  或使用 --candidates 参数提供已有的候选文件。');
      return 'Skipped: BGE embedding model not available. Use --candidates to provide pre-built candidates.';
    }
  }

  const dir = process.cwd();
  const dbPath = resolveDbPath(dir);
  const checkpoint = !full && !since && !candidates ? readExtractionCheckpoint(dbPath) : undefined;
  if (checkpoint) {
    console.log(`Incremental extraction: only messages after ${checkpoint.lastExtractedAt}`);
  }

  let candidatesPath: string;

  if (candidates) {
    // --candidates: use provided file directly (skip Python step)
    candidatesPath = resolve(candidates);
    if (!existsSync(candidatesPath)) {
      return `Candidates file not found: ${candidatesPath}`;
    }
    console.log(`Using provided candidates: ${candidatesPath}`);
  } else {
    try {
      candidatesPath = runPythonPreprocessor(since, checkpoint?.lastExtractedAt);
    } catch (err) {
      return `Failed to run preprocessor: ${err instanceof Error ? err.message : String(err)}`;
    }
    if (checkpoint && !hasCandidateWork(candidatesPath)) {
      return `No new session content after ${checkpoint.lastExtractedAt}. Use --full to reprocess all sessions.`;
    }
  }

  try {
    const result = await extractSessionKnowledge({
      candidatesPath,
      dryRun,
      limit,
      since,
      noQualityGate,
    });
    // Only advance the persistent checkpoint for unbounded session runs.
    // Partial/manual runs (--limit/--since/--candidates/dry-run) must not move it,
    // otherwise default incremental extraction can skip unseen content later.
    const latestTimestamp = shouldPersistExtractionCheckpoint(options, result)
      ? latestCandidateTimestamp(candidatesPath)
      : undefined;
    if (latestTimestamp) {
      writeExtractionCheckpoint(dbPath, { lastExtractedAt: latestTimestamp });
    }
    return formatResult(result, dryRun);
  } catch (err) {
    return `Extraction failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}
