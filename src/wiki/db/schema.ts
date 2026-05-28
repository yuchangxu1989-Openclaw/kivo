/**
 * FR-2 AC-2.1~2.7, NFR-5, NFR-6
 * Schema bootstrap for wiki objects stored in the shared KIVO entries table.
 */

import Database from 'better-sqlite3';

const REQUIRED_ENTRY_COLUMNS: Array<{ name: string; sql: string }> = [
  { name: 'summary', sql: `ALTER TABLE entries ADD COLUMN summary TEXT NOT NULL DEFAULT ''` },
  { name: 'source_json', sql: `ALTER TABLE entries ADD COLUMN source_json TEXT NOT NULL DEFAULT '{}'` },
  { name: 'status', sql: `ALTER TABLE entries ADD COLUMN status TEXT NOT NULL DEFAULT 'active'` },
  { name: 'tags_json', sql: `ALTER TABLE entries ADD COLUMN tags_json TEXT NOT NULL DEFAULT '[]'` },
  { name: 'version', sql: `ALTER TABLE entries ADD COLUMN version INTEGER NOT NULL DEFAULT 1` },
  { name: 'metadata_json', sql: `ALTER TABLE entries ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}'` },
  { name: 'parent_id', sql: `ALTER TABLE entries ADD COLUMN parent_id TEXT` },
  { name: 'sort_order', sql: `ALTER TABLE entries ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0` },
  { name: 'deleted_at', sql: `ALTER TABLE entries ADD COLUMN deleted_at TEXT` },
  { name: 'embedding', sql: `ALTER TABLE entries ADD COLUMN embedding BLOB` },
  { name: 'created_at', sql: `ALTER TABLE entries ADD COLUMN created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP` },
  { name: 'updated_at', sql: `ALTER TABLE entries ADD COLUMN updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP` },
];

export interface WikiSchemaOptions {
  enableForeignKeys?: boolean;
  busyTimeoutMs?: number;
}

export function initializeWikiSchema(
  db: any,
  options: WikiSchemaOptions = {},
): void {
  db.pragma('journal_mode = WAL');
  db.pragma(`busy_timeout = ${options.busyTimeoutMs ?? 5000}`);
  if (options.enableForeignKeys ?? true) {
    db.pragma('foreign_keys = ON');
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS entries (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      source_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'active',
      tags_json TEXT NOT NULL DEFAULT '[]',
      version INTEGER NOT NULL DEFAULT 1,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      parent_id TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      deleted_at TEXT,
      embedding BLOB,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  const columns = db.prepare('PRAGMA table_info(entries)').all() as Array<{ name: string }>;
  const existing = new Set(columns.map((column) => column.name));

  for (const column of REQUIRED_ENTRY_COLUMNS) {
    if (!existing.has(column.name)) {
      db.exec(column.sql);
    }
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_entries_wiki_type ON entries(type);
    CREATE INDEX IF NOT EXISTS idx_entries_wiki_parent ON entries(parent_id, sort_order);
    CREATE INDEX IF NOT EXISTS idx_entries_wiki_status ON entries(status, deleted_at);
    CREATE INDEX IF NOT EXISTS idx_entries_wiki_title ON entries(type, title);

    CREATE TABLE IF NOT EXISTS wiki_links (
      source_page_id TEXT NOT NULL,
      target_page_id TEXT,
      target_title TEXT NOT NULL,
      label TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'missing',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (source_page_id, target_title)
    );

    CREATE INDEX IF NOT EXISTS idx_wiki_links_target_page ON wiki_links(target_page_id);
    CREATE INDEX IF NOT EXISTS idx_wiki_links_status ON wiki_links(status);

    CREATE TABLE IF NOT EXISTS wiki_page_versions (
      id TEXT PRIMARY KEY,
      page_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      tags_json TEXT NOT NULL DEFAULT '[]',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      UNIQUE(page_id, version)
    );

    CREATE INDEX IF NOT EXISTS idx_wiki_page_versions_page ON wiki_page_versions(page_id, version DESC);

    CREATE TABLE IF NOT EXISTS wiki_annotations (
      id TEXT PRIMARY KEY,
      wiki_page_id TEXT NOT NULL,
      content TEXT NOT NULL,
      position INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (wiki_page_id) REFERENCES entries(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_wiki_annotations_page ON wiki_annotations(wiki_page_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS wiki_tags (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      parent_id TEXT,
      path TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_wiki_tags_parent ON wiki_tags(parent_id);
    CREATE INDEX IF NOT EXISTS idx_wiki_tags_name ON wiki_tags(name);

    CREATE TABLE IF NOT EXISTS wiki_community_suggestions (
      id TEXT PRIMARY KEY,
      community_key TEXT NOT NULL,
      page_ids_json TEXT NOT NULL,
      score REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_wiki_community_key ON wiki_community_suggestions(community_key);
  `);
}
