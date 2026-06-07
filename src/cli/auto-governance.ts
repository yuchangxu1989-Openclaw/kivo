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
import { loadDedupThreshold, GOVERNANCE_BEHAVIORAL_TEST_PROMPT } from '../standards/index.js';
import { OpenAILLMProvider } from '../extraction/llm-extractor.js';
import { runGraphAlignment, type GraphAlignmentReport } from '../association/graph-alignment-checker.js';

export interface AutoGovernanceOptions {
  domain?: string;
  threshold?: number;
  similarityThreshold?: number;
  output?: string;
  json?: boolean;
  cwd?: string;
  /** Skip quality audit (LLM-intensive); only run dedup */
  skipQuality?: boolean;
  /** Skip behavioral change test (LLM-intensive) */
  skipBehavioral?: boolean;
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
  graphAlignment: {
    executed: boolean;
    error?: string;
    report?: GraphAlignmentReport;
  };
  fragmentAggregation: {
    executed: boolean;
    error?: string;
    report?: import('../governance/fragment-aggregator.js').AggregationReport;
  };
  behavioral: {
    executed: boolean;
    assessed: number;
    failing: number;
    markedForReview: number;
    skippedReason?: string;
    errors: string[];
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
    lines.push(`  Marked for review: ${summary.decay.report.reviewMarked}`);
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

  lines.push('Graph Alignment (FR-G04)');
  lines.push(`  Executed: ${summary.graphAlignment.executed ? 'yes' : 'no'}`);
  if (summary.graphAlignment.report) {
    lines.push(`  Orphan nodes: ${summary.graphAlignment.report.issues.orphanNodes}`);
    lines.push(`  Missing nodes: ${summary.graphAlignment.report.issues.missingNodes}`);
    lines.push(`  Stale edges: ${summary.graphAlignment.report.issues.staleEdges}`);
    lines.push(`  Weight drift edges: ${summary.graphAlignment.report.issues.weightDriftEdges}`);
  }
  if (summary.graphAlignment.error) {
    lines.push(`  Error: ${summary.graphAlignment.error}`);
  }
  lines.push('');

  lines.push('Fragment Aggregation (FR-N09)');
  lines.push(`  Executed: ${summary.fragmentAggregation.executed ? 'yes' : 'no'}`);
  if (summary.fragmentAggregation.report) {
    lines.push(`  Groups detected: ${summary.fragmentAggregation.report.groupsDetected}`);
    lines.push(`  Entries merged: ${summary.fragmentAggregation.report.entriesMerged}`);
    lines.push(`  Entries superseded: ${summary.fragmentAggregation.report.entriesRemoved}`);
  }
  if (summary.fragmentAggregation.error) {
    lines.push(`  Error: ${summary.fragmentAggregation.error}`);
  }
  lines.push('');

  lines.push('Behavioral Change Test');
  lines.push(`  Executed: ${summary.behavioral.executed ? 'yes' : 'no'}`);
  if (summary.behavioral.skippedReason) {
    lines.push(`  Skipped: ${summary.behavioral.skippedReason}`);
  } else if (summary.behavioral.executed) {
    lines.push(`  Assessed: ${summary.behavioral.assessed}`);
    lines.push(`  Failing: ${summary.behavioral.failing}`);
    lines.push(`  Marked for review: ${summary.behavioral.markedForReview}`);
  }
  if (summary.behavioral.errors.length > 0) {
    for (const err of summary.behavioral.errors.slice(0, 5)) {
      lines.push(`  Error: ${err}`);
    }
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
  const similarityThreshold = options.similarityThreshold ?? loadDedupThreshold(dir);
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
    graphAlignment: {
      executed: false,
    },
    fragmentAggregation: {
      executed: false,
    },
    behavioral: {
      executed: false,
      assessed: 0,
      failing: 0,
      markedForReview: 0,
      errors: [],
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

    // Phase 3.2: Graph alignment (FR-G04) — after graph build/incremental graph updates.
    try {
      const alignOutput = await runGraphAlignment({ cwd: dir, json: true, dryRun: false });
      summary.graphAlignment.executed = true;
      summary.graphAlignment.report = JSON.parse(alignOutput) as GraphAlignmentReport;
    } catch (error) {
      summary.graphAlignment.executed = true;
      summary.graphAlignment.error = (error as Error).message;
    }

    // Phase 3.5: Fragment Aggregation (FR-N09) — runs through MECE governance.
    if (summary.deduplicate.report?.fragmentAggregation) {
      summary.fragmentAggregation.executed = true;
      summary.fragmentAggregation.report = summary.deduplicate.report.fragmentAggregation;
    }

    if (!llmAvailable) {
      summary.warnings.push((llmConfig as { error: string }).error);
      summary.behavioral.skippedReason = 'LLM unavailable; behavioral test skipped.';
      summary.quality.skippedReason = 'LLM unavailable; quality audit and rewrite skipped.';
    } else {
      // Phase 4: Behavioral Change Test (shared admission criteria)
      if (options.skipBehavioral) {
        summary.behavioral.skippedReason = 'Behavioral test skipped (--skip-behavioral).';
      } else {
        try {
          const allEntries = loadEntriesForAudit(db, options.domain);
          const batchSize = options.qualityBatchSize ?? 50;
          const entriesToTest = allEntries.slice(0, batchSize);

          if (entriesToTest.length === 0) {
            summary.behavioral.executed = true;
            summary.behavioral.skippedReason = 'No active entries found.';
          } else {
            const llm = new OpenAILLMProvider({
              apiKey: (llmConfig as { apiKey: string }).apiKey,
              baseUrl: (llmConfig as { baseUrl: string }).baseUrl,
              model: (llmConfig as { model: string }).model,
              timeoutMs: 30_000,
            });

            let assessed = 0;
            let failing = 0;
            let markedForReview = 0;
            const errors: string[] = [];

            for (const entry of entriesToTest) {
              try {
                const truncated = entry.content.length > 1500 ? entry.content.slice(0, 1500) : entry.content;
                const prompt = `${GOVERNANCE_BEHAVIORAL_TEST_PROMPT}\n\n知识标题：${entry.title}\n知识内容：\n${truncated}`;
                const raw = await llm.complete(prompt);

                let cleaned = raw.trim();
                if (cleaned.startsWith('```')) {
                  cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
                }

                const parsed = JSON.parse(cleaned);
                assessed++;

                if (parsed.passes === false) {
                  failing++;
                  // Current lifecycle states route failing entries through review.
                  const now = new Date().toISOString();
                  db.prepare('UPDATE entries SET status = ?, updated_at = ? WHERE id = ?')
                    .run('pending', now, entry.id);
                  markedForReview++;
                }

                // Rate limit
                await new Promise(r => setTimeout(r, 1000));
              } catch (err) {
                errors.push(`Behavioral test failed for "${entry.title}": ${(err as Error).message}`);
              }
            }

            summary.behavioral.executed = true;
            summary.behavioral.assessed = assessed;
            summary.behavioral.failing = failing;
            summary.behavioral.markedForReview = markedForReview;
            summary.behavioral.errors = errors;
          }
        } catch (error) {
          summary.behavioral.executed = true;
          summary.behavioral.errors = [(error as Error).message];
        }
      }

      // Phase 5: Quality Upgrade
      if (options.skipQuality) {
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
    }

    // Phase 6: Domain Goal Constraint Check (FR-M02)
    // Lightweight: only checks entries with matching domain goals configured
    try {
      const { SQLiteDomainGoalStore } = await import('../domain-goal/sqlite-domain-goal-store.js');
      const { enforceConstraints } = await import('../domain-goal/domain-goal-constraints.js');
      const goalStore = new SQLiteDomainGoalStore({ db });
      const domainGoals = goalStore.list();

      if (domainGoals.length > 0) {
        const entries = loadEntriesForAudit(db, options.domain);
        let violations = 0;
        const now = new Date().toISOString();

        for (const entry of entries) {
          const entryDomain = entry.domain;
          const relevantGoals = domainGoals.filter(g => g.domainId === entryDomain);
          if (relevantGoals.length === 0) continue;

          try {
            const partialEntry = {
              id: entry.id,
              type: entry.type,
              title: entry.title,
              content: entry.content,
              summary: '',
              domain: entry.domain,
              knowledgeDomain: entry.domain,
              status: 'active' as const,
              confidence: 1,
              source: { type: 'system' as const, reference: '', timestamp: new Date() },
              tags: [],
              version: 1,
              createdAt: new Date(),
              updatedAt: new Date(),
            };
            const result = await enforceConstraints(partialEntry as any, domainGoals);
            if (!result.allowed) {
              violations++;
              db.prepare('UPDATE entries SET status = ?, updated_at = ? WHERE id = ?')
                .run('pending', now, entry.id);
            }
          } catch {
            // Skip entries that fail constraint check (e.g. embedding unavailable)
          }
        }

        if (violations > 0) {
          summary.warnings.push(`Domain goal check: ${violations} entries flagged as pending (violated domain constraints).`);
        }
      }
    } catch {
      // Domain goal check is non-critical; skip silently if it fails
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
