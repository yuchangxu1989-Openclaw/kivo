CREATE TABLE IF NOT EXISTS analysis_artifacts_status_migration_backup (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  migrated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO analysis_artifacts_status_migration_backup (id, status)
SELECT id, status
  FROM analysis_artifacts
 WHERE status = 'pending' || '_review';

UPDATE analysis_artifacts
   SET status = 'pending',
       updated_at = datetime('now')
 WHERE status = 'pending' || '_review';

CREATE TABLE IF NOT EXISTS analysis_artifacts_new (
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

INSERT OR REPLACE INTO analysis_artifacts_new (
  id,
  source_id,
  status,
  confidence,
  claims_count,
  entity_count,
  concept_count,
  conflict_count,
  gap_count,
  research_query_count,
  review_total,
  review_reviewed,
  created_at,
  updated_at,
  extracted_claims_json,
  entity_candidates_json,
  concept_candidates_json,
  conflict_candidates_json,
  gap_candidates_json,
  recommended_queries_json,
  candidate_decisions_json
)
SELECT
  id,
  source_id,
  status,
  confidence,
  claims_count,
  entity_count,
  concept_count,
  conflict_count,
  gap_count,
  research_query_count,
  review_total,
  review_reviewed,
  created_at,
  updated_at,
  extracted_claims_json,
  entity_candidates_json,
  concept_candidates_json,
  conflict_candidates_json,
  gap_candidates_json,
  recommended_queries_json,
  candidate_decisions_json
FROM analysis_artifacts;

DROP TABLE analysis_artifacts;
ALTER TABLE analysis_artifacts_new RENAME TO analysis_artifacts;

CREATE INDEX IF NOT EXISTS idx_analysis_artifacts_status ON analysis_artifacts(status);
