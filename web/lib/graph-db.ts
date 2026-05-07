/**
 * Graph DB — read-only access to precomputed graph_nodes / graph_edges tables.
 * These tables live in the main kivo.db (populated by CLI `graph-build`),
 * NOT in the kivo-data/kivo.sqlite used by the web app's KnowledgeRepository.
 */

import Database from 'better-sqlite3';
import path from 'path';

const GRAPH_DB_PATH = process.env.KIVO_GRAPH_DB_PATH
  || process.env.KIVO_DB_PATH
  || path.resolve(process.cwd(), '../kivo.db');

let db: Database.Database | null = null;

function getDb(): Database.Database {
  if (!db) {
    db = new Database(GRAPH_DB_PATH, { readonly: true });
    db.pragma('journal_mode = WAL');
  }
  return db;
}

export interface GraphNode {
  entry_id: string;
  type: string;
  title: string;
  domain: string | null;
  tags_json: string;
  created_at: string;
}

export interface GraphEdge {
  id: number;
  source_id: string;
  target_id: string;
  association_type: string;
  edge_source: string;
  weight: number;
  created_at: string;
}

/**
 * Read all precomputed graph nodes, optionally filtered.
 */
export function getGraphNodes(filters?: {
  domain?: string;
  type?: string;
  since?: string;
}): GraphNode[] {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters?.domain) {
    conditions.push('domain = ?');
    params.push(filters.domain);
  }
  if (filters?.type) {
    conditions.push('type = ?');
    params.push(filters.type);
  }
  if (filters?.since) {
    conditions.push('created_at >= ?');
    params.push(filters.since);
  }

  const where = conditions.length > 0 ? ' WHERE ' + conditions.join(' AND ') : '';
  const sql = `SELECT entry_id, type, title, domain, tags_json, created_at FROM graph_nodes${where}`;
  return getDb().prepare(sql).all(...params) as GraphNode[];
}

/**
 * Read precomputed graph edges, optionally filtered to a set of node IDs.
 */
export function getGraphEdges(nodeIds?: Set<string>): GraphEdge[] {
  if (nodeIds && nodeIds.size === 0) return [];

  // If no filter, return all edges
  if (!nodeIds) {
    return getDb().prepare(
      'SELECT id, source_id, target_id, association_type, edge_source, weight, created_at FROM graph_edges'
    ).all() as GraphEdge[];
  }

  // For filtered nodes, get edges where both endpoints are in the set
  const allEdges = getDb().prepare(
    'SELECT id, source_id, target_id, association_type, edge_source, weight, created_at FROM graph_edges'
  ).all() as GraphEdge[];

  return allEdges.filter(e => nodeIds.has(e.source_id) && nodeIds.has(e.target_id));
}

/**
 * Count graph nodes and edges (for stats API).
 */
export function getGraphCounts(): { nodes: number; edges: number } {
  const nodesRow = getDb().prepare('SELECT COUNT(*) as cnt FROM graph_nodes').get() as { cnt: number };
  const edgesRow = getDb().prepare('SELECT COUNT(*) as cnt FROM graph_edges').get() as { cnt: number };
  return { nodes: nodesRow.cnt, edges: edgesRow.cnt };
}

/**
 * Check if graph tables exist and have data.
 */
export function graphTablesExist(): boolean {
  try {
    const row = getDb().prepare(
      "SELECT COUNT(*) as cnt FROM sqlite_master WHERE type='table' AND name IN ('graph_nodes', 'graph_edges')"
    ).get() as { cnt: number };
    return row.cnt === 2;
  } catch {
    return false;
  }
}
