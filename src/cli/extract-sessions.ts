/**
 * CLI: kivo extract-sessions (FR-A05)
 *
 * Extracts knowledge from session history JSONL files via:
 * 1. Python preprocessor (session-knowledge-extractor.py) → candidates JSON
 * 2. LLM extraction → structured knowledge with multi-dimensional tags
 * 3. Write to KIVO DB
 */

import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { extractSessionKnowledge } from './session-knowledge-llm.js';
import type { SessionExtractResult } from './session-knowledge-llm.js';
import Database from 'better-sqlite3';
import { DEFAULT_CONFIG } from '../config/types.js';
import { KnowledgeRepository, SQLiteProvider } from '../repository/index.js';
import type { KnowledgeEntry, KnowledgeType, KnowledgeNature, KnowledgeFunction } from '../types/index.js';
import { shortenKnowledgeTitle } from '../extraction/extraction-utils.js';

export interface ExtractSessionsOptions {
  dryRun?: boolean;
  limit?: number;
  since?: string;
  candidates?: string;
  noQualityGate?: boolean;
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
  const scriptPath = resolve('/root/.openclaw/workspace/scripts/session-knowledge-extractor.py');
  if (!existsSync(scriptPath)) {
    throw new Error(`Python preprocessor not found: ${scriptPath}`);
  }

  const outputPath = resolve('/root/.openclaw/workspace/reports/session-knowledge-candidates.json');
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
  lines.push(`Knowledge extracted: ${result.knowledgeExtracted}`);
  if (!dryRun) {
    lines.push(`Knowledge written:   ${result.knowledgeWritten}`);
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
  const { dryRun = false, limit, since, candidates, noQualityGate = false } = options;

  // Check preprocessor script existence BEFORE expensive BGE check (avoids loading PyTorch for nothing)
  if (!candidates) {
    const scriptPath = resolve('/root/.openclaw/workspace/scripts/session-knowledge-extractor.py');
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

  let candidatesPath: string;

  if (candidates) {
    // --candidates: use provided file directly (skip Python step)
    candidatesPath = resolve(candidates);
    if (!existsSync(candidatesPath)) {
      return `Candidates file not found: ${candidatesPath}`;
    }
    console.log(`Using provided candidates: ${candidatesPath}`);
  } else {
    // Query last processed_at from DB to pass as --since-timestamp
    let sinceTimestamp: string | undefined;
    if (!candidates) {
      try {
        const dir = process.cwd();
        const configPath = join(dir, 'kivo.config.json');
        let dbPath = String(DEFAULT_CONFIG.dbPath);
        if (existsSync(configPath)) {
          const { readFileSync } = await import('node:fs');
          const cfg = JSON.parse(readFileSync(configPath, 'utf-8'));
          if (typeof cfg.dbPath === 'string') dbPath = cfg.dbPath;
        }
        const resolvedDb = resolve(dir, dbPath);
        if (existsSync(resolvedDb)) {
          const db = new Database(resolvedDb);
          const row = db.prepare('SELECT MAX(processed_at) as last_ts FROM processed_sessions').get() as { last_ts: string | null } | undefined;
          if (row?.last_ts) {
            sinceTimestamp = row.last_ts;
            console.log(`Incremental extraction: only messages after ${sinceTimestamp}`);
          }
          db.close();
        }
      } catch {
        // Non-fatal: if we can't read DB, just process everything
      }
    }

    // Run Python preprocessor
    try {
      candidatesPath = runPythonPreprocessor(since, sinceTimestamp);
    } catch (err) {
      return `Failed to run preprocessor: ${err instanceof Error ? err.message : String(err)}`;
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
    return formatResult(result, dryRun);
  } catch (err) {
    return `Extraction failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}
