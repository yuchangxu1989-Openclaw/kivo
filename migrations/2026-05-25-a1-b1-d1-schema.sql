-- KIVO A1+B1+D1 Schema Migration
-- A1: Top-level binary structure for subject_nodes
-- B1: Multi-to-many relationship tables (material_subjects, entry_subjects, wiki_page_entries)
-- D1: Classification disputes table

-- ============================================================
-- A1: Add deletable column to subject_nodes
-- ============================================================
ALTER TABLE subject_nodes ADD COLUMN deletable INTEGER NOT NULL DEFAULT 1;

-- ============================================================
-- B1: Multi-to-many relationship tables
-- ============================================================
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

-- B1: subject_nodes wiki directory reference
ALTER TABLE subject_nodes ADD COLUMN wiki_directory_id TEXT;

-- ============================================================
-- D1: Classification disputes table
-- ============================================================
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
