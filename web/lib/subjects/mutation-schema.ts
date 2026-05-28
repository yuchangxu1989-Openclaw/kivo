import type Database from 'better-sqlite3';

function hasColumn(db: Database.Database, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === column);
}

export function ensureSubjectMutationSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS subject_aliases (
      id TEXT PRIMARY KEY,
      subject_id TEXT NOT NULL,
      alias_name TEXT NOT NULL,
      alias_kind TEXT NOT NULL DEFAULT 'manual',
      created_at INTEGER NOT NULL,
      UNIQUE(subject_id, alias_name)
    );

    CREATE INDEX IF NOT EXISTS idx_subject_aliases_subject_id
      ON subject_aliases(subject_id);

    CREATE TABLE IF NOT EXISTS subject_history (
      id TEXT PRIMARY KEY,
      subject_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_subject_history_subject_id_created_at
      ON subject_history(subject_id, created_at DESC);
  `);

  if (!hasColumn(db, 'subject_nodes', 'status')) {
    db.exec(`ALTER TABLE subject_nodes ADD COLUMN status TEXT DEFAULT 'active'`);
  }

  if (!hasColumn(db, 'entries', 'subject_id')) {
    db.exec(`ALTER TABLE entries ADD COLUMN subject_id TEXT`);
  }

  if (!hasColumn(db, 'subject_aliases', 'alias_embedding')) {
    db.exec(`ALTER TABLE subject_aliases ADD COLUMN alias_embedding BLOB`);
  }
}
