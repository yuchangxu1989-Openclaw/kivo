CREATE TABLE IF NOT EXISTS analysis_artifacts (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  confidence REAL NOT NULL DEFAULT 0.5,
  claims_count INTEGER NOT NULL DEFAULT 0,
  entity_count INTEGER NOT NULL DEFAULT 0,
  concept_count INTEGER NOT NULL DEFAULT 0,
  conflict_count INTEGER NOT NULL DEFAULT 0,
  gap_count INTEGER NOT NULL DEFAULT 0,
  research_query_count INTEGER NOT NULL DEFAULT 0,
  review_total INTEGER NOT NULL DEFAULT 0,
  review_reviewed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  extracted_claims_json TEXT NOT NULL DEFAULT '[]',
  entity_candidates_json TEXT NOT NULL DEFAULT '[]',
  concept_candidates_json TEXT NOT NULL DEFAULT '[]',
  conflict_candidates_json TEXT NOT NULL DEFAULT '[]',
  gap_candidates_json TEXT NOT NULL DEFAULT '[]',
  recommended_queries_json TEXT NOT NULL DEFAULT '[]',
  candidate_decisions_json TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS intent_hit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  intent_id TEXT NOT NULL,
  hit_at TEXT NOT NULL DEFAULT (datetime('now')),
  channel TEXT DEFAULT 'api'
);

CREATE INDEX IF NOT EXISTS idx_intent_hit_log_intent_id ON intent_hit_log(intent_id);
CREATE INDEX IF NOT EXISTS idx_intent_hit_log_hit_at ON intent_hit_log(hit_at);
