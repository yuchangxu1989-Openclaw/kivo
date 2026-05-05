/**
 * kivo audit-quality — Knowledge quality audit command (FR-N03)
 *
 * AC coverage:
 *   AC1: Three-dimension evaluation via quality-auditor
 *   AC2: LLM quality scoring 1-5
 *   AC3: Score ≤ threshold → failing + rewrite suggestion
 *   AC5: --domain <value> to filter by domain
 *   AC6: Quality report (total, distribution, fail rate, top-10 worst)
 *   AC7: All assessment via LLM
 *   AC8: --threshold <N> custom threshold
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import Database from 'better-sqlite3';
import { DEFAULT_CONFIG } from '../config/types.js';
import { assessQuality, buildQualityReport, formatQualityReport } from './quality-auditor.js';
import type { EntryForAudit } from './quality-auditor.js';

export interface AuditQualityOptions {
  domain?: string;
  threshold?: number;
  limit?: number;
  json?: boolean;
  cwd?: string;
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

export async function runAuditQuality(options: AuditQualityOptions = {}): Promise<string> {
  const dir = resolve(options.cwd ?? process.cwd());
  const dbPath = resolveDbPath(dir);
  const threshold = options.threshold ?? 2;

  if (!existsSync(dbPath)) {
    return options.json
      ? JSON.stringify({ error: 'Database not found. Run `kivo init` first.' })
      : '✗ Database not found. Run `kivo init` first.';
  }

  const db = new Database(dbPath);

  // Load entries, optionally filtered by domain
  const limitClause = options.limit ? ` LIMIT ${Number(options.limit)}` : '';
  let entries: EntryForAudit[];
  if (options.domain) {
    entries = db.prepare(
      `SELECT id, type, title, content, domain FROM entries WHERE status = 'active' AND (domain = ? OR knowledge_domain = ?) ORDER BY created_at DESC${limitClause}`
    ).all(options.domain, options.domain) as EntryForAudit[];
  } else {
    entries = db.prepare(
      `SELECT id, type, title, content, domain FROM entries WHERE status = 'active' ORDER BY created_at DESC${limitClause}`
    ).all() as EntryForAudit[];
  }

  const totalCount = (db.prepare('SELECT COUNT(*) as cnt FROM entries').get() as { cnt: number }).cnt;
  db.close();

  if (entries.length === 0) {
    return options.json
      ? JSON.stringify({ totalEntries: totalCount, assessed: 0, message: 'No active entries found.' })
      : '⚠ No active entries found to audit.';
  }

  console.log(`Auditing ${entries.length} entries (threshold=${threshold})...`);

  const assessments = await assessQuality(entries, threshold);
  const report = buildQualityReport(assessments, totalCount, threshold);

  if (options.json) {
    return JSON.stringify(report, null, 2);
  }

  return formatQualityReport(report);
}
