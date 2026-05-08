import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { DEFAULT_CONFIG } from '../config/types.js';
import { shortenKnowledgeTitle } from '../extraction/extraction-utils.js';
import { runDeduplicateScan, type DeduplicateReport } from './mece-governance.js';
import { assessQuality, rewriteEntry, type EntryForAudit, type QualityAssessment } from './quality-auditor.js';
import { resolveLlmConfig } from './resolve-llm-config.js';
import { applyDecay, type DecayReport } from '../governance/decay-engine.js';
import { generateHealthReport, ensureUsageColumns, type HealthReport } from '../governance/health-monitor.js';

export interface AutoGovernanceOptions {
  domain?: string;
  threshold?: number;
  similarityThreshold?: number;
  output?: string;
  json?: boolean;
  cwd?: string;
  /** Skip quality audit (LLM-intensive); only run dedup */
  skipQuality?: boolean;
  /** Max entries to assess in quality audit (default: 50) */
  qualityBatchSize?: number;
}

export interface AutoGovernanceSummary {
  timestamp: string;
  dbPath: string;
  llmAvailable: boolean;
  warnings: string[];
  decay: {
    executed: boolean;
    report?: DecayReport;
    error?: string;
  };
  health: {
    executed: boolean;
    report?: HealthReport;
    error?: string;
  };
  deduplicate: {
    executed: boolean;
    error?: string;
    report?: DeduplicateReport;
  };
  quality: {
    executed: boolean;
    threshold: number;
    assessed: number;
    failing: number;
    rewritten: number;
    rewriteFailed: number;
    skippedReason?: string;
    errors: string[];
    worstEntries: Array<{
      entryId: string;
      title: string;
      score: number;
      rationale: string;
    }>;
  };
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

function ensureEntriesColumns(db: Database.Database): void {
  const columns = db.prepare('PRAGMA table_info(entries)').all() as Array<{ name: string }>;
  const colNames = new Set(columns.map(c => c.name));

  if (!colNames.has('embedding')) db.exec('ALTER TABLE entries ADD COLUMN embedding BLOB');
  if (!colNames.has('similar_sentences')) db.exec(`ALTER TABLE entries ADD COLUMN similar_sentences TEXT DEFAULT '[]'`);
  if (!colNames.has('nature')) db.exec('ALTER TABLE entries ADD COLUMN nature TEXT');
  if (!colNames.has('function_tag')) db.exec('ALTER TABLE entries ADD COLUMN function_tag TEXT');
  if (!colNames.has('knowledge_domain')) db.exec('ALTER TABLE entries ADD COLUMN knowledge_domain TEXT');
}

function loadEntriesForAudit(db: Database.Database, domain?: string): EntryForAudit[] {
  if (domain) {
    return db.prepare(
      `SELECT id, type, title, content, domain FROM entries WHERE status = 'active' AND (domain = ? OR knowledge_domain = ?) ORDER BY created_at DESC`,
    ).all(domain, domain) as EntryForAudit[];
  }

  return db.prepare(
    `SELECT id, type, title, content, domain FROM entries WHERE status = 'active' ORDER BY created_at DESC`,
  ).all() as EntryForAudit[];
}

async function withCwd<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const original = process.cwd();
  if (original === dir) return fn();
  process.chdir(dir);
  try {
    return await fn();
  } finally {
    process.chdir(original);
  }
}

async function rewriteLowQualityEntries(
  db: Database.Database,
  entries: EntryForAudit[],
  assessments: QualityAssessment[],
): Promise<{ rewritten: number; rewriteFailed: number; errors: string[] }> {
  const failing = assessments.filter(a => !a.passing && a.score.rewriteSuggestion);
  const result = {
    rewritten: 0,
    rewriteFailed: 0,
    errors: [] as string[],
  };

  for (const assessment of failing) {
    const entry = entries.find(item => item.id === assessment.entryId);
    if (!entry || !assessment.score.rewriteSuggestion) continue;

    try {
      const rewritten = await rewriteEntry(entry, assessment.score.rewriteSuggestion);
      if (!rewritten) {
        result.rewriteFailed++;
        result.errors.push(`Failed to rewrite "${entry.title}": invalid LLM response`);
        continue;
      }

      const now = new Date().toISOString();
      const newId = randomUUID();

      db.transaction(() => {
        db.prepare('UPDATE entries SET status = ?, updated_at = ? WHERE id = ?')
          .run('active', now, entry.id);

        const oldRow = db.prepare('SELECT * FROM entries WHERE id = ?').get(entry.id) as Record<string, unknown>;

        db.prepare(`
          INSERT INTO entries (id, type, title, content, summary, source_json, confidence, status, tags_json, domain, version, supersedes, similar_sentences, nature, function_tag, knowledge_domain, embedding, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          newId,
          oldRow.type,
          shortenKnowledgeTitle(rewritten.title, rewritten.content),
          rewritten.content,
          rewritten.summary,
          oldRow.source_json,
          oldRow.confidence,
          oldRow.tags_json,
          oldRow.domain,
          (typeof oldRow.version === 'number' ? oldRow.version : 1) + 1,
          entry.id,
          oldRow.similar_sentences ?? '[]',
          oldRow.nature,
          oldRow.function_tag,
          oldRow.knowledge_domain,
          null,
          now,
          now,
        );
      })();

      result.rewritten++;
      await new Promise(r => setTimeout(r, 1000));
    } catch (error) {
      result.rewriteFailed++;
      result.errors.push(`Failed to rewrite "${entry.title}": ${(error as Error).message}`);
    }
  }

  return result;
}

function formatAutoGovernanceSummary(summary: AutoGovernanceSummary): string {
  const lines: string[] = [];
  lines.push('═══ KIVO Auto Governance Report ═══');
  lines.push(`Time: ${summary.timestamp}`);
  lines.push(`DB: ${summary.dbPath}`);
  lines.push(`LLM: ${summary.llmAvailable ? 'available' : 'unavailable'}`);
  lines.push('');

  lines.push('Decay Engine');
  lines.push(`  Executed: ${summary.decay.executed ? 'yes' : 'no'}`);
  if (summary.decay.report) {
    lines.push(`  Decayed: ${summary.decay.report.decayed}`);
    lines.push(`  Marked stale: ${summary.decay.report.stalemarked}`);
  }
  if (summary.decay.error) {
    lines.push(`  Error: ${summary.decay.error}`);
  }
  lines.push('');

  lines.push('Health Monitor');
  lines.push(`  Executed: ${summary.health.executed ? 'yes' : 'no'}`);
  if (summary.health.report) {
    lines.push(`  Health Score: ${summary.health.report.healthScore}/100`);
    lines.push(`  Coverage: ${summary.health.report.dimensions.coverageScore}/100`);
    lines.push(`  Freshness: ${summary.health.report.dimensions.freshnessScore}/100`);
    lines.push(`  Quality: ${summary.health.report.dimensions.qualityScore}/100`);
    lines.push(`  Usage: ${summary.health.report.dimensions.usageScore}/100`);
    lines.push(`  Alerts: ${summary.health.report.alerts.length}`);
    for (const alert of summary.health.report.alerts) {
      const icon = alert.severity === 'critical' ? '🔴' : alert.severity === 'warning' ? '🟡' : '🔵';
      lines.push(`    ${icon} ${alert.message}`);
    }
  }
  if (summary.health.error) {
    lines.push(`  Error: ${summary.health.error}`);
  }
  lines.push('');

  lines.push('MECE Deduplication');
  lines.push(`  Executed: ${summary.deduplicate.executed ? 'yes' : 'no'}`);
  if (summary.deduplicate.report) {
    lines.push(`  Scanned: ${summary.deduplicate.report.scannedEntries}/${summary.deduplicate.report.totalEntries}`);
    lines.push(`  Duplicate pairs: ${summary.deduplicate.report.duplicatePairs.length}`);
    lines.push(`  Auto merged: ${summary.deduplicate.report.autoMerged}`);
  }
  if (summary.deduplicate.error) {
    lines.push(`  Error: ${summary.deduplicate.error}`);
  }
  lines.push('');

  lines.push('Quality Upgrade');
  lines.push(`  Executed: ${summary.quality.executed ? 'yes' : 'no'}`);
  lines.push(`  Threshold: ${summary.quality.threshold}`);
  lines.push(`  Assessed: ${summary.quality.assessed}`);
  lines.push(`  Failing: ${summary.quality.failing}`);
  lines.push(`  Rewritten: ${summary.quality.rewritten}`);
  lines.push(`  Rewrite failed: ${summary.quality.rewriteFailed}`);
  if (summary.quality.skippedReason) {
    lines.push(`  Skipped: ${summary.quality.skippedReason}`);
  }
  if (summary.quality.worstEntries.length > 0) {
    lines.push('  Lowest scores:');
    for (const item of summary.quality.worstEntries.slice(0, 5)) {
      lines.push(`    - [${item.score}] ${item.title} (${item.entryId.slice(0, 8)})`);
    }
  }

  const allWarnings = [...summary.warnings, ...summary.quality.errors];
  if (allWarnings.length > 0) {
    lines.push('');
    lines.push('Warnings');
    for (const warning of allWarnings) {
      lines.push(`  - ${warning}`);
    }
  }

  return lines.join('\n');
}

export async function runAutoGovernance(options: AutoGovernanceOptions = {}): Promise<string> {
  const dir = resolve(options.cwd ?? process.cwd());
  const dbPath = resolveDbPath(dir);
  const threshold = options.threshold ?? 2;
  const similarityThreshold = options.similarityThreshold ?? 0.80;
  const timestamp = new Date().toISOString();

  if (!existsSync(dbPath)) {
    const message = 'Database not found. Run `kivo init` first.';
    return options.json ? JSON.stringify({ error: message }, null, 2) : `✗ ${message}`;
  }

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  ensureEntriesColumns(db);

  const llmConfig = resolveLlmConfig();
  const llmAvailable = !('error' in llmConfig);

  const summary: AutoGovernanceSummary = {
    timestamp,
    dbPath,
    llmAvailable,
    warnings: [],
    decay: {
      executed: false,
    },
    health: {
      executed: false,
    },
    deduplicate: {
      executed: false,
    },
    quality: {
      executed: false,
      threshold,
      assessed: 0,
      failing: 0,
      rewritten: 0,
      rewriteFailed: 0,
      errors: [],
      worstEntries: [],
    },
  };

  try {
    // Phase 1: Decay engine (pure local, no LLM needed)
    try {
      const decayReport = applyDecay(db);
      summary.decay.executed = true;
      summary.decay.report = decayReport;
    } catch (error) {
      summary.decay.executed = true;
      summary.decay.error = (error as Error).message;
    }

    // Phase 2: Health monitor (pure local, no LLM needed)
    try {
      const healthReport = generateHealthReport(db);
      summary.health.executed = true;
      summary.health.report = healthReport;
    } catch (error) {
      summary.health.executed = true;
      summary.health.error = (error as Error).message;
    }

    // Phase 3: MECE Deduplication
    try {
      const report = await withCwd(dir, () =>
        runDeduplicateScan({
          threshold: similarityThreshold,
          auto: true,
          domain: options.domain,
        }),
      );
      summary.deduplicate.executed = true;
      summary.deduplicate.report = report;
    } catch (error) {
      summary.deduplicate.executed = true;
      summary.deduplicate.error = (error as Error).message;
    }

    if (!llmAvailable) {
      summary.warnings.push((llmConfig as { error: string }).error);
      summary.quality.skippedReason = 'LLM unavailable; quality audit and rewrite skipped.';
    } else if (options.skipQuality) {
      summary.quality.skippedReason = 'Quality audit skipped (--skip-quality).';
    } else {
      const allEntries = loadEntriesForAudit(db, options.domain);
      // Limit batch size to avoid LLM timeout (default 50)
      const batchSize = options.qualityBatchSize ?? 50;
      const entries = allEntries.slice(0, batchSize);
      if (entries.length === 0) {
        summary.quality.executed = true;
        summary.quality.skippedReason = 'No active entries found.';
      } else {
        const assessments = await assessQuality(entries, threshold);
        const failing = assessments.filter(item => !item.passing && item.score.rewriteSuggestion);
        const worstEntries = [...assessments]
          .sort((a, b) => a.score.overall - b.score.overall)
          .slice(0, 10)
          .map(item => ({
            entryId: item.entryId,
            title: item.title,
            score: item.score.overall,
            rationale: item.score.rationale,
          }));

        summary.quality.executed = true;
        summary.quality.assessed = assessments.length;
        summary.quality.failing = failing.length;
        summary.quality.worstEntries = worstEntries;

        const rewriteResult = await rewriteLowQualityEntries(db, entries, assessments);
        summary.quality.rewritten = rewriteResult.rewritten;
        summary.quality.rewriteFailed = rewriteResult.rewriteFailed;
        summary.quality.errors = rewriteResult.errors;

        if (rewriteResult.rewritten > 0) {
          try {
            db.exec(`INSERT INTO entries_fts(entries_fts) VALUES('rebuild')`);
          } catch {
            summary.warnings.push('FTS rebuild failed after auto rewrite.');
          }
        }
      }
    }
  } finally {
    db.close();
  }

  const output = options.json
    ? JSON.stringify(summary, null, 2)
    : formatAutoGovernanceSummary(summary);

  if (options.output) {
    const outputPath = resolve(dir, options.output);
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, output + '\n', 'utf-8');
  }

  return output;
}
