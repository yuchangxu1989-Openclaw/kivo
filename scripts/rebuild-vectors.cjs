#!/usr/bin/env node
/**
 * Rebuild all entry embeddings from 1024-dim (float64) to 2048-dim (float32).
 * Calls localhost:9876/v1/embeddings with doubao-embedding-vision-251215.
 * 
 * Usage: node scripts/rebuild-vectors.js [--batch-size 10] [--dry-run]
 */

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.resolve(__dirname, '../kivo.db');
const EMBED_URL = 'http://localhost:9876/v1/embeddings';
const MODEL = 'doubao-embedding-vision-251215';
const EXPECTED_DIM = 2048;
const BATCH_SIZE = parseInt(process.argv.find((_, i, a) => a[i-1] === '--batch-size') || '10');
const DRY_RUN = process.argv.includes('--dry-run');

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function getEmbeddings(texts) {
  const res = await fetch(EMBED_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, input: texts }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Embedding API error ${res.status}: ${body}`);
  }
  const json = await res.json();
  return json.data.sort((a, b) => a.index - b.index).map(d => d.embedding);
}

async function main() {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  // Count entries with old embeddings
  const totalWithEmbed = db.prepare("SELECT COUNT(*) as c FROM entries WHERE embedding IS NOT NULL").get().c;
  const totalEntries = db.prepare("SELECT COUNT(*) as c FROM entries WHERE status = 'active'").get().c;
  console.log(`Total active entries: ${totalEntries}`);
  console.log(`Entries with existing embeddings: ${totalWithEmbed}`);

  // Clear all embeddings first
  if (!DRY_RUN) {
    db.prepare("UPDATE entries SET embedding = NULL").run();
    console.log('Cleared all existing embeddings.');
  }

  // Get all active entries
  const rows = db.prepare(
    "SELECT id, title, content FROM entries WHERE status = 'active' ORDER BY created_at DESC"
  ).all();

  console.log(`Will embed ${rows.length} entries in batches of ${BATCH_SIZE}...`);
  if (DRY_RUN) {
    console.log('DRY RUN - no changes will be made.');
    db.close();
    return;
  }

  const updateStmt = db.prepare('UPDATE entries SET embedding = ? WHERE id = ?');
  let embedded = 0;
  let failed = 0;
  const totalBatches = Math.ceil(rows.length / BATCH_SIZE);

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const texts = batch.map(r => `${r.title}\n${r.content}`);

    try {
      const embeddings = await getEmbeddings(texts);
      for (let j = 0; j < batch.length; j++) {
        const vec = embeddings[j];
        if (!vec || vec.length !== EXPECTED_DIM) {
          console.error(`  ✗ [${batch[j].id.slice(0,8)}] dim=${vec?.length}, expected ${EXPECTED_DIM}`);
          failed++;
          continue;
        }
        const blob = Buffer.from(new Float32Array(vec).buffer);
        updateStmt.run(blob, batch[j].id);
        embedded++;
      }
      process.stdout.write(`  Batch ${batchNum}/${totalBatches}: ${embedded} embedded, ${failed} failed\r`);
    } catch (err) {
      console.error(`\n  ✗ Batch ${batchNum} failed: ${err.message}`);
      // Retry one by one
      for (const row of batch) {
        try {
          const [vec] = await getEmbeddings([`${row.title}\n${row.content}`]);
          if (vec && vec.length === EXPECTED_DIM) {
            const blob = Buffer.from(new Float32Array(vec).buffer);
            updateStmt.run(blob, row.id);
            embedded++;
          } else {
            failed++;
          }
        } catch (e) {
          console.error(`    ✗ [${row.id.slice(0,8)}] ${e.message}`);
          failed++;
        }
        await sleep(200);
      }
    }

    // Sleep between batches to avoid rate limiting
    if (i + BATCH_SIZE < rows.length) {
      await sleep(500);
    }
  }

  console.log(`\n\n✓ Rebuild complete: ${embedded} embedded, ${failed} failed (total ${rows.length})`);

  // Verify: check 3 random entries
  const samples = db.prepare(
    "SELECT id, title, LENGTH(embedding) as len FROM entries WHERE embedding IS NOT NULL ORDER BY RANDOM() LIMIT 3"
  ).all();
  console.log('\nVerification (3 random samples):');
  for (const s of samples) {
    const dims = s.len / 4; // float32 = 4 bytes
    const status = dims === EXPECTED_DIM ? '✓' : '✗';
    console.log(`  ${status} [${s.id.slice(0,8)}] "${s.title}" → ${dims} dims (${s.len} bytes)`);
  }

  db.close();
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
