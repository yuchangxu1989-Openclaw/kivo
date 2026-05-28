#!/usr/bin/env npx tsx
/**
 * E1 Migration: Create independent `intents` table and migrate type='intent' entries.
 *
 * Usage:
 *   npx tsx scripts/migrate-e1-intents.ts [--dry-run]
 *
 * This script:
 * 1. Creates the `intents` table if it doesn't exist
 * 2. Migrates entries with type='intent' into the new table
 * 3. Marks migrated entries with status='migrated_to_intents'
 */

import Database from 'better-sqlite3';
import path from 'node:path';
import { existsSync } from 'node:fs';

const DRY_RUN = process.argv.includes('--dry-run');
const DB_PATH = process.env.KIVO_DB_PATH || path.resolve(process.cwd(), 'kivo.db');

if (!existsSync(DB_PATH)) {
  console.error(`✗ Database not found at: ${DB_PATH}`);
  process.exit(1);
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Step 1: Create intents table
const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS intents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  positives_json TEXT NOT NULL DEFAULT '[]',
  negatives_json TEXT NOT NULL DEFAULT '[]',
  embedding BLOB,
  confidence REAL NOT NULL DEFAULT 0.8,
  status TEXT NOT NULL DEFAULT 'active',
  hit_count INTEGER NOT NULL DEFAULT 0,
  last_hit_at TEXT,
  source_session_id TEXT,
  source_message_id TEXT,
  similar_sentences_json TEXT NOT NULL DEFAULT '[]',
  metadata_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

const CREATE_INDEXES_SQL = `
CREATE INDEX IF NOT EXISTS idx_intents_status ON intents(status);
CREATE INDEX IF NOT EXISTS idx_intents_name ON intents(name);
CREATE INDEX IF NOT EXISTS idx_intents_hit_count ON intents(hit_count);
`;

console.log(`${DRY_RUN ? '[DRY RUN] ' : ''}E1 Migration: Intent Knowledge Separation`);
console.log(`Database: ${DB_PATH}`);
console.log('');

// Check if table already exists
const tableExists = db.prepare(
  "SELECT name FROM sqlite_master WHERE type='table' AND name='intents'"
).get();

if (tableExists) {
  console.log('✓ intents table already exists');
} else {
  if (!DRY_RUN) {
    db.exec(CREATE_TABLE_SQL);
    db.exec(CREATE_INDEXES_SQL);
    console.log('✓ Created intents table with indexes');
  } else {
    console.log('[DRY RUN] Would create intents table');
  }
}

// Step 2: Count entries to migrate
interface EntryRow {
  id: string;
  title: string;
  content: string;
  embedding: Buffer | null;
  confidence: number;
  status: string;
  similar_sentences: string | null;
  metadata_json: string | null;
  created_at: string;
  updated_at: string;
  usage_count: number | null;
  last_hit_at: string | null;
}

const entriesToMigrate = db.prepare(`
  SELECT id, title, content, embedding, confidence, status,
         similar_sentences, metadata_json, created_at, updated_at,
         usage_count, last_hit_at
  FROM entries
  WHERE type = 'intent' AND status != 'migrated_to_intents'
`).all() as EntryRow[];

console.log(`Found ${entriesToMigrate.length} intent entries to migrate`);

if (entriesToMigrate.length === 0) {
  console.log('✓ No entries to migrate (already done or none exist)');
  db.close();
  process.exit(0);
}

// Step 3: Migrate entries
function parsePositivesNegatives(metadataJson: string | null): { positives: string[]; negatives: string[] } {
  if (!metadataJson) return { positives: [], negatives: [] };
  try {
    const meta = JSON.parse(metadataJson) as Record<string, unknown>;
    const positives = Array.isArray(meta.positives) ? meta.positives.filter((s: unknown) => typeof s === 'string') : [];
    const negatives = Array.isArray(meta.negatives) ? meta.negatives.filter((s: unknown) => typeof s === 'string') : [];
    return { positives, negatives };
  } catch {
    return { positives: [], negatives: [] };
  }
}

function parseSimilarSentences(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((s: unknown) => typeof s === 'string') : [];
  } catch {
    return [];
  }
}

if (!DRY_RUN) {
  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO intents (
      id, name, description, positives_json, negatives_json,
      embedding, confidence, status, hit_count, last_hit_at,
      similar_sentences_json, metadata_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const markMigratedStmt = db.prepare(`
    UPDATE entries SET status = 'migrated_to_intents', updated_at = datetime('now')
    WHERE id = ?
  `);

  const migrate = db.transaction(() => {
    let migrated = 0;
    let skipped = 0;

    for (const entry of entriesToMigrate) {
      const { positives, negatives } = parsePositivesNegatives(entry.metadata_json);
      const similarSentences = parseSimilarSentences(entry.similar_sentences);

      const result = insertStmt.run(
        entry.id,
        entry.title,
        entry.content,
        JSON.stringify(positives),
        JSON.stringify(negatives),
        entry.embedding,
        entry.confidence,
        entry.status === 'active' ? 'active' : entry.status,
        entry.usage_count ?? 0,
        entry.last_hit_at,
        JSON.stringify(similarSentences),
        entry.metadata_json,
        entry.created_at,
        entry.updated_at,
      );

      if (result.changes > 0) {
        markMigratedStmt.run(entry.id);
        migrated++;
      } else {
        skipped++;
      }
    }

    return { migrated, skipped };
  });

  const { migrated, skipped } = migrate();
  console.log(`✓ Migrated ${migrated} entries to intents table`);
  if (skipped > 0) {
    console.log(`  (${skipped} already existed in intents table, skipped)`);
  }
} else {
  console.log(`[DRY RUN] Would migrate ${entriesToMigrate.length} entries`);
  for (const entry of entriesToMigrate.slice(0, 5)) {
    console.log(`  - ${entry.id}: ${entry.title}`);
  }
  if (entriesToMigrate.length > 5) {
    console.log(`  ... and ${entriesToMigrate.length - 5} more`);
  }
}

// Step 4: Verify
if (!DRY_RUN) {
  const intentCount = (db.prepare('SELECT count(*) as cnt FROM intents').get() as { cnt: number }).cnt;
  const migratedCount = (db.prepare("SELECT count(*) as cnt FROM entries WHERE status = 'migrated_to_intents'").get() as { cnt: number }).cnt;
  console.log('');
  console.log('Verification:');
  console.log(`  intents table: ${intentCount} rows`);
  console.log(`  entries marked migrated: ${migratedCount} rows`);
}

db.close();
console.log('');
console.log('✓ E1 migration complete');
