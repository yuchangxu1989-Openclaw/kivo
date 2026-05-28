import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { PendingClassificationsRepository } from '../../lib/pending-classifications/repository';
import { ensureMaterialsTable } from '../../lib/wiki-materials-store';

function createDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE entries (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      source_json TEXT NOT NULL,
      metadata_json TEXT,
      subject_id TEXT,
      updated_at TEXT
    );

    CREATE TABLE subject_nodes (
      id TEXT PRIMARY KEY,
      parent_id TEXT,
      name TEXT NOT NULL,
      tree_kind TEXT NOT NULL DEFAULT 'subject',
      origin TEXT NOT NULL DEFAULT 'manual',
      created_by_material_id TEXT,
      created_at INTEGER NOT NULL,
      confidence REAL,
      aliases TEXT,
      merged_into TEXT,
      level INTEGER DEFAULT 0,
      status TEXT DEFAULT 'active'
    );
  `);
  ensureMaterialsTable(db);
  return db;
}

function seedSubject(db: Database.Database, id: string): void {
  db.prepare(
    `INSERT INTO subject_nodes
       (id, parent_id, name, tree_kind, origin, created_at, level, status)
     VALUES (?, NULL, ?, 'subject', 'manual', ?, 0, 'active')`,
  ).run(id, id, Date.now());
}

function seedMaterial(db: Database.Database, id: string): void {
  db.prepare(`
    INSERT INTO materials (
      id, file_name, mime_type, file_size, status, space_id, wiki_page_count,
      created_at, updated_at, storage_path, wiki_page_ids_json, error_message,
      classification_status, asset_kind, source_channel, source_ref, subject_node_id
    ) VALUES (?, ?, 'text/plain', 1, 'processing', 'default', 0,
      ?, ?, '', '[]', NULL, 'pending_classification', 'text', 'api', ?, NULL)
  `).run(id, `${id}.txt`, new Date().toISOString(), new Date().toISOString(), `api://material/${id}`);
}

describe('PendingClassificationsRepository entry subject backfill', () => {
  it('backfills null entries.subject_id for entries extracted before A2 confirmation', () => {
    const db = createDb();
    try {
      seedSubject(db, 'subject-history');
      seedMaterial(db, 'material-before-a2');
      db.prepare(`
        INSERT INTO entries (id, title, source_json, subject_id, updated_at)
        VALUES (?, ?, ?, NULL, ?)
      `).run(
        'entry-before-a2',
        'A2 前已提取的条目',
        JSON.stringify({ type: 'document', reference: 'material-before-a2', timestamp: new Date(), materialId: 'material-before-a2' }),
        new Date().toISOString(),
      );

      const result = new PendingClassificationsRepository(db).confirm('material-before-a2', 'subject-history');

      expect(result.subjectNodeId).toBe('subject-history');
      const entry = db
        .prepare(`SELECT subject_id FROM entries WHERE id = 'entry-before-a2'`)
        .get() as { subject_id: string | null };
      expect(entry.subject_id).toBe('subject-history');
    } finally {
      db.close();
    }
  });
});
