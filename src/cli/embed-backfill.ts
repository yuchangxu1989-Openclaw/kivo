/**
 * Embed Backfill — batch-generate Ollama/BGE embeddings for entries missing
 * embeddings or carrying stale dimensions.
 *
 * Processes entries in batches (default 10) with a configurable sleep
 * between batches to avoid timeouts during cron execution.
 *
 * Usage: kivo embed-backfill [--batch-size 10] [--sleep-ms 1000] [--json]
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import Database from 'better-sqlite3';
import { DEFAULT_CONFIG } from '../config/types.js';
import { createEmbeddingProvider } from '../embedding/create-provider.js';
import { readEmbeddingConfig } from '../embedding/health-check.js';

export interface EmbedBackfillOptions {
  /** Number of entries to process per batch (default: 10) */
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
  const batchSize = options.batchSize ?? 10;
  const sleepMs = options.sleepMs ?? 1000;

  const dbPath = resolveDbPath();
  if (!existsSync(dbPath)) {
    const msg = 'Database not found. Run `kivo init` first.';
    return options.json ? JSON.stringify({ error: msg }) : `✗ ${msg}`;
  }

  const embeddingConfig = readEmbeddingConfig(process.cwd());
  const embedder = createEmbeddingProvider(embeddingConfig);
  const targetDim = embedder.dimensions();

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  // Find entries missing embeddings or carrying stale dimensions.
  const rows = db.prepare(
    `SELECT id, title, content FROM entries
     WHERE status = 'active'
       AND (embedding IS NULL OR length(embedding) / 4 != ?)
     ORDER BY created_at DESC`,
  ).all(targetDim) as EntryRow[];

  if (rows.length === 0) {
    db.close();
    const msg = `All active entries already have ${targetDim}-dim embeddings.`;
    return options.json ? JSON.stringify({ total: 0, embedded: 0, targetDim }) : `✓ ${msg}`;
  }

  console.log(`Embed backfill: ${rows.length} entries need ${targetDim}-dim embeddings via ${embedder.modelId()}, batch size ${batchSize}`);

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

      const entriesWithText = batch.map(entry => ({ entry, text: buildEmbeddingText(entry) }));

      try {
        const embeddings = await embedder.embedBatch(entriesWithText.map(item => item.text));
        for (let i = 0; i < entriesWithText.length; i++) {
          const { entry } = entriesWithText[i];
          const embedding = embeddings[i];
          if (!embedding || embedding.length !== targetDim) {
            throw new Error(`Embedding dimension mismatch for [${entry.id.slice(0, 8)}]: got ${embedding?.length ?? 0}, expected ${targetDim}`);
          }
          const blob = Buffer.from(new Float32Array(embedding).buffer);
          updateStmt.run(blob, entry.id);
          totalEmbedded++;
        }
      } catch (batchErr) {
        console.error(`    ✗ Batch embedding failed, retrying entries one by one: ${batchErr instanceof Error ? batchErr.message : String(batchErr)}`);
        for (const { entry, text } of entriesWithText) {
          try {
            const embedding = await embedder.embed(text);
            if (embedding.length !== targetDim) {
              throw new Error(`Embedding dimension mismatch: got ${embedding.length}, expected ${targetDim}`);
            }
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
      }

      // Sleep between batches (skip after last batch)
      if (batchIdx < totalBatches - 1) {
        await sleep(sleepMs);
      }
    }
  } finally {
    if ('close' in embedder && typeof embedder.close === 'function') {
      await embedder.close();
    }
    db.close();
  }

  const summary = `✓ Embed backfill: ${totalEmbedded}/${rows.length} entries embedded as ${targetDim}-dim ${embedder.modelId()}` +
    (totalFailed > 0 ? ` (${totalFailed} failed)` : '');

  console.log(summary);

  if (options.json) {
    return JSON.stringify({
      total: rows.length,
      embedded: totalEmbedded,
      failed: totalFailed,
      targetDim,
      model: embedder.modelId(),
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
