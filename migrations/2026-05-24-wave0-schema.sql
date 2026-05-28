-- KIVO Web Wave 0 schema migration
-- materials 加 11 字段
ALTER TABLE materials ADD COLUMN subject_node_id TEXT;
ALTER TABLE materials ADD COLUMN classification_status TEXT DEFAULT 'pending';
ALTER TABLE materials ADD COLUMN classification_confidence REAL;
ALTER TABLE materials ADD COLUMN suggested_subject_name TEXT;
ALTER TABLE materials ADD COLUMN pipeline_status TEXT;
ALTER TABLE materials ADD COLUMN slice_count INTEGER DEFAULT 0;
ALTER TABLE materials ADD COLUMN extract_count INTEGER DEFAULT 0;
ALTER TABLE materials ADD COLUMN inject_count INTEGER DEFAULT 0;
ALTER TABLE materials ADD COLUMN asset_kind TEXT;
ALTER TABLE materials ADD COLUMN source_channel TEXT;
ALTER TABLE materials ADD COLUMN source_ref TEXT;

-- subject_nodes 必须 0 行启动
CREATE TABLE IF NOT EXISTS subject_nodes (
  id TEXT PRIMARY KEY,
  parent_id TEXT,
  name TEXT NOT NULL,
  tree_kind TEXT NOT NULL DEFAULT 'subject',
  origin TEXT NOT NULL DEFAULT 'auto',
  created_by_material_id TEXT,
  created_at INTEGER NOT NULL,
  confidence REAL,
  aliases TEXT,
  merged_into TEXT,
  level INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS personal_state (
  learner_id TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  mastery TEXT,
  confidence REAL,
  evidence_count INTEGER DEFAULT 0,
  last_seen INTEGER,
  review_plan TEXT,
  weak_reason TEXT,
  mistake_records_json TEXT,
  PRIMARY KEY (learner_id, entry_id)
);

CREATE TABLE IF NOT EXISTS research_tasks (
  id TEXT PRIMARY KEY,
  description TEXT,
  status TEXT,
  report_path TEXT,
  source_channel TEXT,
  created_at INTEGER,
  completed_at INTEGER,
  adopted_at INTEGER,
  produced_entry_ids_json TEXT
);

ALTER TABLE graph_edges ADD COLUMN edge_view TEXT DEFAULT 'subject';
