/**
 * kivo upgrade-quality — Batch LLM rewrite of low-quality entries (FR-N03)
 *
 * AC coverage:
 *   AC4: --batch mode, old version preserved (new version inserted)
 *   AC5: --domain <value> to filter by domain
 *   AC8: --threshold <N> custom threshold
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { DEFAULT_CONFIG } from '../config/types.js';
import { shortenKnowledgeTitle } from '../extraction/extraction-utils.js';
import { assessQuality, rewriteEntry } from './quality-auditor.js';
import type { EntryForAudit } from './quality-auditor.js';

export interface UpgradeQualityOptions {
  batch?: boolean;
  domain?: string;
  threshold?: number;
  dryRun?: boolean;
  json?: boolean;
  cwd?: string;
}

interface UpgradeResult {
  assessed: number;
  failing: number;
  rewritten: number;
  rewriteFailed: number;
  errors: string[];
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

export async function runUpgradeQuality(options: UpgradeQualityOptions = {}): Promise<string> {
  const dir = resolve(options.cwd ?? process.cwd());
  const dbPath = resolveDbPath(dir);
  const threshold = options.threshold ?? 2;

  if (!existsSync(dbPath)) {
    return options.json
      ? JSON.stringify({ error: 'Database not found. Run `kivo init` first.' })
      : '✗ Database not found. Run `kivo init` first.';
  }

  const db = new Database(dbPath);

  // Load active entries, optionally filtered by domain
  let entries: EntryForAudit[];
  if (options.domain) {
    entries = db.prepare(
      `SELECT id, type, title, content, domain FROM entries WHERE status = 'active' AND (domain = ? OR knowledge_domain = ?) ORDER BY created_at DESC`
    ).all(options.domain, options.domain) as EntryForAudit[];
  } else {
    entries = db.prepare(
      `SELECT id, type, title, content, domain FROM entries WHERE status = 'active' ORDER BY created_at DESC`
    ).all() as EntryForAudit[];
  }

  if (entries.length === 0) {
    db.close();
    return options.json
      ? JSON.stringify({ assessed: 0, failing: 0, rewritten: 0 })
      : '⚠ No active entries found to upgrade.';
  }

  console.log(`Assessing ${entries.length} entries for quality upgrade (threshold=${threshold})...`);

  // Step 1: Assess quality
  const assessments = await assessQuality(entries, threshold);
  const failing = assessments.filter(a => !a.passing && a.score.rewriteSuggestion);

  const result: UpgradeResult = {
    assessed: assessments.length,
    failing: failing.length,
    rewritten: 0,
    rewriteFailed: 0,
    errors: [],
  };

  if (failing.length === 0) {
    db.close();
    return options.json
      ? JSON.stringify(result)
      : `✓ All ${assessments.length} entries pass quality threshold (>${threshold}). No upgrades needed.`;
  }

  console.log(`Found ${failing.length} entries below threshold. ${options.dryRun ? '[DRY-RUN] ' : ''}Rewriting...`);

  // Ensure columns exist
  const columns = db.prepare('PRAGMA table_info(entries)').all() as Array<{ name: string }>;
  const colNames = new Set(columns.map(c => c.name));
  if (!colNames.has('similar_sentences')) db.exec(`ALTER TABLE entries ADD COLUMN similar_sentences TEXT DEFAULT '[]'`);
  if (!colNames.has('nature')) db.exec('ALTER TABLE entries ADD COLUMN nature TEXT');
  if (!colNames.has('function_tag')) db.exec('ALTER TABLE entries ADD COLUMN function_tag TEXT');
  if (!colNames.has('knowledge_domain')) db.exec('ALTER TABLE entries ADD COLUMN knowledge_domain TEXT');

  // Step 2: Rewrite failing entries
  for (const assessment of failing) {
    const entry = entries.find(e => e.id === assessment.entryId);
    if (!entry) continue;

    console.log(`  Rewriting: "${entry.title}" (score=${assessment.score.overall})...`);

    try {
      const rewritten = await rewriteEntry(entry, assessment.score.rewriteSuggestion!);
      if (!rewritten) {
        result.rewriteFailed++;
        result.errors.push(`Failed to rewrite "${entry.title}": LLM returned invalid response`);
        continue;
      }

      if (options.dryRun) {
        console.log(`    [DRY-RUN] Would rewrite: "${shortenKnowledgeTitle(rewritten.title, rewritten.content)}"`);
        result.rewritten++;
        continue;
      }

      // AC4: Mark old entry as superseded, insert new version
      const now = new Date().toISOString();
      const newId = randomUUID();

      db.transaction(() => {
        // Mark old as superseded
        db.prepare('UPDATE entries SET status = ?, updated_at = ? WHERE id = ?')
          .run('active', now, entry.id);

        // Get old entry's full row for copying metadata
        const oldRow = db.prepare('SELECT * FROM entries WHERE id = ?').get(entry.id) as Record<string, unknown>;

        // Insert new version
        db.prepare(`
          INSERT INTO entries (id, type, title, content, summary, source_json, confidence, status, tags_json, domain, version, supersedes, similar_sentences, nature, function_tag, knowledge_domain, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          ((oldRow.version as number) || 1) + 1,
          entry.id, // supersedes the old entry
          oldRow.similar_sentences ?? '[]',
          oldRow.nature,
          oldRow.function_tag,
          oldRow.knowledge_domain,
          now,
          now,
        );
      })();

      result.rewritten++;
      console.log(`    ✓ Rewritten as ${newId.slice(0, 8)} (old ${entry.id.slice(0, 8)} → active)`);
    } catch (err) {
      const msg = (err as Error).message;
      result.rewriteFailed++;
      result.errors.push(`Failed to rewrite "${entry.title}": ${msg}`);
      console.error(`    ✗ ${msg}`);
    }

    // Rate limit between rewrites
    await new Promise(r => setTimeout(r, 1000));
  }

  // Rebuild FTS
  try { db.exec(`INSERT INTO entries_fts(entries_fts) VALUES('rebuild')`); } catch { /* non-fatal */ }
  db.close();

  if (options.json) {
    return JSON.stringify(result, null, 2);
  }

  const lines = [
    `${options.dryRun ? '[DRY-RUN] ' : ''}✓ Quality upgrade complete:`,
    `  Assessed:       ${result.assessed}`,
    `  Below threshold: ${result.failing}`,
    `  Rewritten:      ${result.rewritten}`,
    `  Rewrite failed: ${result.rewriteFailed}`,
  ];
  if (result.errors.length > 0) {
    lines.push(`  Errors:`);
    for (const e of result.errors) lines.push(`    - ${e}`);
  }
  return lines.join('\n');
}
