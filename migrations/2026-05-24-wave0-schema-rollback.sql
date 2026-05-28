-- KIVO Web Wave 0 rollback
-- SQLite cannot DROP COLUMN safely across all deployed versions without table rebuild.
-- Rollback removes tables introduced by this migration and clears graph edge view metadata.
DROP TABLE IF EXISTS subject_nodes;
DROP TABLE IF EXISTS personal_state;
DROP TABLE IF EXISTS research_tasks;
UPDATE graph_edges SET edge_view = NULL WHERE edge_view = 'subject';
