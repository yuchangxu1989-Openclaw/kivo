#!/usr/bin/env node
/**
 * Fix long titles in KIVO knowledge DB.
 * FR-N05 AC8: title ≤ 20 chars.
 *
 * Compression rules (no LLM):
 *  1. Remove parenthetical content: (...) / （...）
 *  2. Remove content after colon if remainder is mostly non-CJK
 *  3. Hard truncate to 19 chars + '…'
 */

import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, '..', 'kivo.db');
const TITLE_HARD_LIMIT = 20;

function compressTitle(title) {
  if (title.length <= TITLE_HARD_LIMIT) return title;

  let t = title;

  // Step 1: Remove parenthetical content
  t = t.replace(/[（(][^)）]*[)）]/g, '').trim();
  if (t.length <= TITLE_HARD_LIMIT && t.length > 0) return t;

  // Step 2: If colon present and after-colon is mostly non-CJK, keep only before
  const colonMatch = t.match(/^(.+?)[：:](.*)/s);
  if (colonMatch) {
    const before = colonMatch[1].trim();
    const after = colonMatch[2].trim();
    const nonCjk = after.replace(/[\u4e00-\u9fff\u3400-\u4dbf]/g, '').length;
    if (after.length > 0 && nonCjk / after.length > 0.6) {
      t = before;
      if (t.length <= TITLE_HARD_LIMIT && t.length > 0) return t;
    }
  }

  // Step 3: Hard truncate
  if (t.length > TITLE_HARD_LIMIT) {
    t = t.slice(0, TITLE_HARD_LIMIT - 1) + '…';
  }
  return t || title.slice(0, TITLE_HARD_LIMIT - 1) + '…';
}

// Main
const db = new Database(DB_PATH);

const rows = db.prepare(
  `SELECT id, title FROM entries WHERE status='active' AND length(title) > ?`
).all(TITLE_HARD_LIMIT);

console.log(`Found ${rows.length} entries with title > ${TITLE_HARD_LIMIT} chars`);

const update = db.prepare(`UPDATE entries SET title = ?, updated_at = datetime('now') WHERE id = ?`);

const changes = [];
const txn = db.transaction(() => {
  for (const row of rows) {
    const newTitle = compressTitle(row.title);
    if (newTitle !== row.title) {
      update.run(newTitle, row.id);
      changes.push({ id: row.id, old: row.title, new: newTitle });
    }
  }
});

txn();

console.log(`Updated ${changes.length} titles:`);
for (const c of changes) {
  console.log(`  "${c.old}" → "${c.new}"`);
}

// Verify
const remaining = db.prepare(
  `SELECT COUNT(*) as cnt FROM entries WHERE status='active' AND length(title) > ?`
).get(TITLE_HARD_LIMIT);

console.log(`\nRemaining entries with title > ${TITLE_HARD_LIMIT}: ${remaining.cnt}`);

db.close();
process.exit(remaining.cnt === 0 ? 0 : 1);
