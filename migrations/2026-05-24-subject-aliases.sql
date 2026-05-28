CREATE TABLE IF NOT EXISTS subject_aliases (
  id TEXT PRIMARY KEY,
  subject_id TEXT NOT NULL,
  alias_name TEXT NOT NULL,
  alias_kind TEXT NOT NULL DEFAULT 'manual',
  created_at INTEGER NOT NULL,
  UNIQUE(subject_id, alias_name),
  FOREIGN KEY(subject_id) REFERENCES subject_nodes(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_subject_aliases_subject_id
  ON subject_aliases(subject_id);
