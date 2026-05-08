/**
 * Embed Backfill — batch-generate BGE embeddings for entries missing them.
 *
 * Processes entries in batches (default 20) with a configurable sleep
 * between batches to avoid timeouts during cron execution.
 *
 * Usage: kivo embed-backfill [--batch-size 20] [--sleep-ms 1000] [--json]
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import Database from 'better-sqlite3';
import { DEFAULT_CONFIG } from '../config/types.js';

export interface EmbedBackfillOptions {
  /** Number of entries to process per batch (default: 20) */
  batchSize?: number;
  /** Milliseconds to sleep between batches (default: 1000) */
  sleepMs?: number;
  /** Output JSON format */
  json?: boolean;
}

interface EntryRow {
  id: string;
  title: string;
  content: string;
}

function resolveDbPath(): string {
  const dir = process.cwd();
  const configPath = join(dir, 'kivo.config.json');
  let dbPath = process.env.KIVO_DB_PATH ?? String(DEFAULT_CONFIG.dbPath);
  if (!process.env.KIVO_DB_PATH && existsSync(configPath)) {
    const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
    if (typeof raw.dbPath === 'string') dbPath = raw.dbPath;
  }
  return resolve(dir, dbPath);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Build the text to embed for an entry (same logic as intake-quality-gate).
 * Combines title + content for richer semantic representation.
 */
function buildEmbeddingText(entry: EntryRow): string {
  return `${entry.title}\n${entry.content}`;
}

export async function runEmbedBackfill(options: EmbedBackfillOptions = {}): Promise<string> {
  const batchSize = options.batchSize ?? 20;
  const sleepMs = options.sleepMs ?? 1000;

  const dbPath = resolveDbPath();
  if (!existsSync(dbPath)) {
    const msg = 'Database not found. Run `kivo init` first.';
    return options.json ? JSON.stringify({ error: msg }) : `✗ ${msg}`;
  }

  // Check BGE availability
  const { BgeEmbedder } = await import('../extraction/bge-embedder.js');
  if (!BgeEmbedder.isAvailable()) {
    const msg = 'BGE embedder not available. Install: pip install sentence-transformers';
    return options.json ? JSON.stringify({ error: msg }) : `✗ ${msg}`;
  }

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  // Find entries missing embeddings
  const rows = db.prepare(
    `SELECT id, title, content FROM entries WHERE status = 'active' AND embedding IS NULL ORDER BY created_at DESC`,
  ).all() as EntryRow[];

  if (rows.length === 0) {
    db.close();
    const msg = 'All active entries already have embeddings.';
    return options.json ? JSON.stringify({ total: 0, embedded: 0 }) : `✓ ${msg}`;
  }

  console.log(`Embed backfill: ${rows.length} entries missing embeddings, batch size ${batchSize}`);

  const embedder = new BgeEmbedder();
  const updateStmt = db.prepare('UPDATE entries SET embedding = ? WHERE id = ?');

  let totalEmbedded = 0;
  let totalFailed = 0;
  const errors: string[] = [];

  try {
    const totalBatches = Math.ceil(rows.length / batchSize);

    for (let batchIdx = 0; batchIdx < totalBatches; batchIdx++) {
      const batchStart = batchIdx * batchSize;
      const batch = rows.slice(batchStart, batchStart + batchSize);

      console.log(`  Batch ${batchIdx + 1}/${totalBatches} (${batch.length} entries)...`);

      for (const entry of batch) {
        try {
          const text = buildEmbeddingText(entry);
          const embedding = await embedder.embed(text);
          const blob = Buffer.from(new Float32Array(embedding).buffer);
          updateStmt.run(blob, entry.id);
          totalEmbedded++;
        } catch (err) {
          const msg = `Failed to embed [${entry.id.slice(0, 8)}] "${entry.title}": ${err instanceof Error ? err.message : String(err)}`;
          console.error(`    ✗ ${msg}`);
          errors.push(msg);
          totalFailed++;
        }
      }

      // Sleep between batches (skip after last batch)
      if (batchIdx < totalBatches - 1) {
        await sleep(sleepMs);
      }
    }
  } finally {
    await embedder.close();
    db.close();
  }

  const summary = `✓ Embed backfill: ${totalEmbedded}/${rows.length} entries embedded` +
    (totalFailed > 0 ? ` (${totalFailed} failed)` : '');

  console.log(summary);

  if (options.json) {
    return JSON.stringify({
      total: rows.length,
      embedded: totalEmbedded,
      failed: totalFailed,
      errors: errors.length > 0 ? errors : undefined,
    });
  }

  const lines = [summary];
  if (errors.length > 0) {
    lines.push('Errors:');
    for (const e of errors.slice(0, 10)) {
      lines.push(`  ${e}`);
    }
    if (errors.length > 10) {
      lines.push(`  ... and ${errors.length - 10} more`);
    }
  }
  return lines.join('\n');
}
