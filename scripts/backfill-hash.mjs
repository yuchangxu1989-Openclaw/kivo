#!/usr/bin/env node
// Backfill content_hash for entries that have NULL content_hash
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';

const dbPath = '/root/.openclaw/workspace/projects/kivo/kivo.db';
const db = new Database(dbPath);

const entries = db.prepare('SELECT id, content FROM entries WHERE content_hash IS NULL').all();
console.log(`Found ${entries.length} entries with NULL content_hash`);

const update = db.prepare('UPDATE entries SET content_hash = ? WHERE id = ?');
const txn = db.transaction(() => {
  for (const entry of entries) {
    const hash = createHash('sha256').update(entry.content).digest('hex');
    update.run(hash, entry.id);
  }
});
txn();

console.log(`Backfilled ${entries.length} entries`);

// Check for duplicates
const dupes = db.prepare("SELECT content_hash, count(*) as cnt FROM entries WHERE status='active' AND content_hash IS NOT NULL GROUP BY content_hash HAVING cnt > 1").all();
console.log(`Found ${dupes.length} duplicate content_hash groups`);
if (dupes.length > 0) {
  console.log('Top 5 duplicates:');
  for (const d of dupes.slice(0, 5)) {
    const rows = db.prepare("SELECT id, substr(content,1,60) as snippet FROM entries WHERE content_hash = ? AND status='active'").all(d.content_hash);
    console.log(`  Hash ${d.content_hash.slice(0,12)}... (${d.cnt} copies):`);
    for (const r of rows) {
      console.log(`    ${r.id}: ${r.snippet}`);
    }
  }
}

db.close();
