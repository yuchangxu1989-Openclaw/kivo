/**
 * kivo audit-value — Batch audit existing knowledge entries for value (FR-N04 AC5).
 *
 * Scans all active entries, runs LLM value assessment on each,
 * and reports high/low value breakdown.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import Database from 'better-sqlite3';
import { DEFAULT_CONFIG } from '../config/types.js';
import { batchAssessValue, type ValueAssessment } from '../pipeline/value-gate.js';

export interface AuditValueOptions {
  /** Only audit entries in this domain */
  domain?: string;
  /** Max entries to audit (default: all) */
  limit?: number;
  /** Apply action on low-value entries (currently no-op, all entries stay active) */
  apply?: boolean;
  /** Output as JSON */
  json?: boolean;
}

interface AuditRow {
  id: string;
  title: string;
  content: string;
  type: string;
  status: string;
  domain: string | null;
}

export async function runAuditValue(options: AuditValueOptions = {}): Promise<string> {
  const dir = process.cwd();
  const configPath = join(dir, 'kivo.config.json');

  let dbPath = String(DEFAULT_CONFIG.dbPath);
  if (existsSync(configPath)) {
    const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
    if (typeof raw.dbPath === 'string') dbPath = raw.dbPath;
  }

  const resolvedDb = resolve(dir, dbPath);
  if (!existsSync(resolvedDb)) {
    return 'Database not found. Run "kivo init" first.';
  }

  const db = new Database(resolvedDb);

  // Build query
  const conditions: string[] = ['status = ?'];
  const params: (string | number)[] = ['active'];

  if (options.domain) {
    conditions.push('domain = ?');
    params.push(options.domain);
  }

  const limitClause = options.limit ? ` LIMIT ${options.limit}` : '';
  const sql = `SELECT id, title, content, type, status, domain FROM entries WHERE ${conditions.join(' AND ')}${limitClause}`;
  const rows = db.prepare(sql).all(...params) as AuditRow[];

  if (rows.length === 0) {
    db.close();
    return options.json
      ? JSON.stringify({ total: 0, highValue: 0, lowValue: 0, entries: [] })
      : 'No active entries found to audit.';
  }

  console.log(`Auditing ${rows.length} entries...`);

  const entriesToAssess = rows.map(r => ({
    id: r.id,
    title: r.title,
    content: r.content,
  }));

  const assessments = await batchAssessValue(entriesToAssess, dir);

  // Collect results
  const highValue: Array<{ id: string; title: string; category: string; confidence: number }> = [];
  const lowValue: Array<{ id: string; title: string; category: string; reasoning: string }> = [];

  for (const { id, assessment } of assessments) {
    const row = rows.find(r => r.id === id)!;
    if (assessment.isHighValue) {
      highValue.push({ id, title: row.title, category: assessment.category, confidence: assessment.confidence });
    } else {
      lowValue.push({ id, title: row.title, category: assessment.category, reasoning: assessment.reasoning });
    }
  }

  // Optionally apply: log low-value entries (status stays active)
  if (options.apply && lowValue.length > 0) {
    console.log(`Identified ${lowValue.length} low-value entries (status unchanged, all remain active).`);
  }

  db.close();

  if (options.json) {
    return JSON.stringify({
      total: rows.length,
      highValue: highValue.length,
      lowValue: lowValue.length,
      applied: !!options.apply,
      entries: assessments.map(({ id, assessment }) => ({
        id,
        ...assessment,
      })),
    }, null, 2);
  }

  // Human-readable output
  const lines: string[] = [];
  lines.push(`\n📊 Value Audit Report`);
  lines.push(`Total: ${rows.length} | High-value: ${highValue.length} | Low-value: ${lowValue.length}`);
  lines.push('');

  if (highValue.length > 0) {
    lines.push('✅ High-value entries:');
    for (const e of highValue.slice(0, 20)) {
      lines.push(`  [${e.category}] ${e.title} (confidence: ${e.confidence.toFixed(2)})`);
    }
    if (highValue.length > 20) lines.push(`  ... and ${highValue.length - 20} more`);
    lines.push('');
  }

  if (lowValue.length > 0) {
    lines.push('⚠ Low-value entries:');
    for (const e of lowValue.slice(0, 20)) {
      lines.push(`  [${e.category}] ${e.title} — ${e.reasoning}`);
    }
    if (lowValue.length > 20) lines.push(`  ... and ${lowValue.length - 20} more`);
    lines.push('');
  }

  if (options.apply) {
    lines.push(`✓ ${lowValue.length} low-value entries identified (status unchanged).`);
  } else if (lowValue.length > 0) {
    lines.push(`Run with --apply to flag low-value entries.`);
  }

  return lines.join('\n');
}
