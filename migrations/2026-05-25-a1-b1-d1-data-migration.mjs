#!/usr/bin/env node
/**
 * KIVO A1+B1+D1 Data Migration Script
 *
 * A1: Insert system root nodes, migrate existing top-level nodes
 * B1: Migrate existing FK data to relationship tables
 *
 * Usage: node migrations/2026-05-25-a1-b1-d1-data-migration.mjs [dbPath]
 */

import Database from 'better-sqlite3';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

const dbPath = process.argv[2] || resolve(process.cwd(), 'kivo.db');

if (!existsSync(dbPath)) {
  console.error(`Database not found: ${dbPath}`);
  process.exit(1);
}

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = OFF'); // Disable during migration

console.log(`[A1+B1+D1 Migration] Database: ${dbPath}`);

// ============================================================
// Phase 0: Apply schema changes if not already applied
// ============================================================
const columns = db.prepare('PRAGMA table_info(subject_nodes)').all().map(c => c.name);
if (!columns.includes('deletable')) {
  console.log('[Schema] Adding deletable column to subject_nodes...');
  db.exec('ALTER TABLE subject_nodes ADD COLUMN deletable INTEGER NOT NULL DEFAULT 1');
}
if (!columns.includes('wiki_directory_id')) {
  console.log('[Schema] Adding wiki_directory_id column to subject_nodes...');
  db.exec('ALTER TABLE subject_nodes ADD COLUMN wiki_directory_id TEXT');
}

// Create relationship tables
db.exec(`
  CREATE TABLE IF NOT EXISTS material_subjects (
    material_id TEXT NOT NULL,
    subject_id TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'primary',
    confidence REAL DEFAULT 1.0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (material_id, subject_id)
  );
  CREATE INDEX IF NOT EXISTS idx_material_subjects_subject ON material_subjects(subject_id);
  CREATE INDEX IF NOT EXISTS idx_material_subjects_role ON material_subjects(role);

  CREATE TABLE IF NOT EXISTS entry_subjects (
    entry_id TEXT NOT NULL,
    subject_id TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'primary',
    confidence REAL DEFAULT 1.0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (entry_id, subject_id)
  );
  CREATE INDEX IF NOT EXISTS idx_entry_subjects_subject ON entry_subjects(subject_id);
  CREATE INDEX IF NOT EXISTS idx_entry_subjects_role ON entry_subjects(role);

  CREATE TABLE IF NOT EXISTS wiki_page_entries (
    wiki_page_id TEXT NOT NULL,
    entry_id TEXT NOT NULL,
    relation TEXT NOT NULL DEFAULT 'contains',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (wiki_page_id, entry_id)
  );
  CREATE INDEX IF NOT EXISTS idx_wiki_page_entries_entry ON wiki_page_entries(entry_id);

  CREATE TABLE IF NOT EXISTS classification_disputes (
    id TEXT PRIMARY KEY,
    material_id TEXT NOT NULL,
    original_subject_id TEXT,
    suggested_subject_id TEXT,
    reason TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    resolved_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_disputes_material ON classification_disputes(material_id);
  CREATE INDEX IF NOT EXISTS idx_disputes_status ON classification_disputes(status);
`);
console.log('[Schema] All tables and indexes created/verified.');

// ============================================================
// Phase 1-4 wrapped in a transaction (P0-1 fix: atomic data migration)
// Phase 0 (DDL) stays outside because SQLite DDL cannot be rolled back.
// ============================================================
const migrateData = db.transaction(() => {

// ---- Phase 1 (A1): Insert system root nodes ----
const now = Math.floor(Date.now() / 1000);

const existingRootGeneral = db.prepare("SELECT id FROM subject_nodes WHERE id = 'root-general'").get();
const existingRootDiscipline = db.prepare("SELECT id FROM subject_nodes WHERE id = 'root-discipline'").get();

const insertRoot = db.prepare(`
  INSERT OR IGNORE INTO subject_nodes (id, parent_id, name, tree_kind, origin, created_at, level, status, deletable)
  VALUES (?, NULL, ?, 'subject', 'system', ?, 0, 'active', 0)
`);

if (!existingRootGeneral) {
  insertRoot.run('root-general', '通用知识', now);
  console.log('[A1] Inserted root-general node');
} else {
  db.prepare("UPDATE subject_nodes SET deletable = 0 WHERE id = 'root-general'").run();
  console.log('[A1] root-general already exists, ensured deletable=0');
}

if (!existingRootDiscipline) {
  insertRoot.run('root-discipline', '学科知识', now);
  console.log('[A1] Inserted root-discipline node');
} else {
  db.prepare("UPDATE subject_nodes SET deletable = 0 WHERE id = 'root-discipline'").run();
  console.log('[A1] root-discipline already exists, ensured deletable=0');
}

// ============================================================
// Phase 2 (A1): Migrate existing top-level nodes under roots
// ============================================================
const GENERAL_PATTERN = '通用学习资料';

// Find existing top-level nodes (level=0, no parent, not the new roots)
const topLevelNodes = db.prepare(`
  SELECT id, name, level FROM subject_nodes
  WHERE (parent_id IS NULL OR parent_id = '')
    AND id NOT IN ('root-general', 'root-discipline')
    AND merged_into IS NULL
    AND COALESCE(status, 'active') = 'active'
`).all();

console.log(`[A1] Found ${topLevelNodes.length} top-level nodes to migrate`);

const migrateToRoot = db.prepare(`
  UPDATE subject_nodes SET parent_id = ?, level = level + 1 WHERE id = ?
`);

const migrateChildren = db.prepare(`
  UPDATE subject_nodes SET level = level + 1
  WHERE parent_id = ? AND id != ?
`);

for (const node of topLevelNodes) {
  const targetRoot = node.name === GENERAL_PATTERN ? 'root-general' : 'root-discipline';
  migrateToRoot.run(targetRoot, node.id);
  console.log(`[A1] Migrated "${node.name}" → ${targetRoot}`);
}

// Increment level for all descendants of migrated nodes
// We need to recursively update levels for all descendants
function incrementDescendantLevels(parentId) {
  const children = db.prepare(`
    SELECT id FROM subject_nodes WHERE parent_id = ? AND id NOT IN ('root-general', 'root-discipline')
  `).all(parentId);
  for (const child of children) {
    db.prepare('UPDATE subject_nodes SET level = level + 1 WHERE id = ?').run(child.id);
    incrementDescendantLevels(child.id);
  }
}

// Only increment descendants of the originally top-level nodes (now level 1)
for (const node of topLevelNodes) {
  incrementDescendantLevels(node.id);
}

console.log('[A1] Level adjustment complete');

// ============================================================
// Phase 3 (B1): Migrate materials.subject_node_id → material_subjects
// ============================================================
const materialsWithSubject = db.prepare(`
  SELECT id, subject_node_id FROM materials
  WHERE subject_node_id IS NOT NULL AND subject_node_id != ''
`).all();

const insertMaterialSubject = db.prepare(`
  INSERT OR IGNORE INTO material_subjects (material_id, subject_id, role, confidence, created_at)
  VALUES (?, ?, 'primary', 1.0, datetime('now'))
`);

let materialsMigrated = 0;
for (const mat of materialsWithSubject) {
  insertMaterialSubject.run(mat.id, mat.subject_node_id);
  materialsMigrated++;
}
console.log(`[B1] Migrated ${materialsMigrated} material→subject relationships`);

// ============================================================
// Phase 4 (B1): Migrate entries.subject_id → entry_subjects
// ============================================================
const entriesWithSubject = db.prepare(`
  SELECT id, subject_id FROM entries
  WHERE subject_id IS NOT NULL AND subject_id != ''
`).all();

const insertEntrySubject = db.prepare(`
  INSERT OR IGNORE INTO entry_subjects (entry_id, subject_id, role, confidence, created_at)
  VALUES (?, ?, 'primary', 1.0, datetime('now'))
`);

let entriesMigrated = 0;
for (const entry of entriesWithSubject) {
  insertEntrySubject.run(entry.id, entry.subject_id);
  entriesMigrated++;
}
console.log(`[B1] Migrated ${entriesMigrated} entry→subject relationships`);

}); // end transaction

// Execute the transaction — rolls back all Phase 1-4 changes on any error
try {
  migrateData();
} catch (err) {
  console.error('[FATAL] Migration transaction failed, all data changes rolled back.');
  console.error(err);
  db.close();
  process.exit(1);
}

// ============================================================
// Summary
// ============================================================
const finalRoots = db.prepare(`
  SELECT id, name, level, deletable FROM subject_nodes
  WHERE id IN ('root-general', 'root-discipline')
`).all();
console.log('\n[Summary] System root nodes:');
for (const r of finalRoots) {
  console.log(`  ${r.id}: "${r.name}" level=${r.level} deletable=${r.deletable}`);
}

const totalNodes = db.prepare('SELECT COUNT(*) as c FROM subject_nodes WHERE merged_into IS NULL').get();
const totalMaterialSubjects = db.prepare('SELECT COUNT(*) as c FROM material_subjects').get();
const totalEntrySubjects = db.prepare('SELECT COUNT(*) as c FROM entry_subjects').get();
console.log(`[Summary] Total active nodes: ${totalNodes.c}`);
console.log(`[Summary] material_subjects rows: ${totalMaterialSubjects.c}`);
console.log(`[Summary] entry_subjects rows: ${totalEntrySubjects.c}`);

db.close();
console.log('\n[Done] A1+B1+D1 migration complete.');
