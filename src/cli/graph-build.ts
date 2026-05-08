/**
 * kivo graph build — Build knowledge graph from existing entries and persist to DB.
 *
 * Loads all active entries, builds in-memory graph with tag-based co-occurrence
 * edges, then persists nodes and edges to SQLite tables (graph_nodes, graph_edges).
 * Also runs GraphInsightEngine and stores insights.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import Database from 'better-sqlite3';
import { DEFAULT_CONFIG } from '../config/types.js';
import { KnowledgeGraph } from '../graph/knowledge-graph.js';
import { GraphInsightEngine } from '../graph/graph-insight-engine.js';
import type { KnowledgeEntry } from '../types/index.js';

export interface GraphBuildOptions {
  cwd?: string;
  json?: boolean;
}

function resolveDbPath(dir: string): string {
  const configPath = join(dir, 'kivo.config.json');
  let dbPath = process.env.KIVO_DB_PATH ?? String(DEFAULT_CONFIG.dbPath);
  if (!process.env.KIVO_DB_PATH && existsSync(configPath)) {
    const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
    if (typeof raw.dbPath === 'string') dbPath = raw.dbPath;
  }
  return resolve(dir, dbPath);
}

function initGraphSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS graph_nodes (
      entry_id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      domain TEXT,
      tags_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS graph_edges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id TEXT NOT NULL,
      target_id TEXT NOT NULL,
      association_type TEXT NOT NULL,
      edge_source TEXT NOT NULL,
      weight REAL NOT NULL DEFAULT 0.5,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(source_id, target_id, edge_source)
    );

    CREATE INDEX IF NOT EXISTS idx_graph_edges_source ON graph_edges(source_id);
    CREATE INDEX IF NOT EXISTS idx_graph_edges_target ON graph_edges(target_id);

    CREATE TABLE IF NOT EXISTS graph_insights (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      description TEXT NOT NULL,
      importance TEXT NOT NULL,
      affected_node_ids_json TEXT NOT NULL DEFAULT '[]',
      metadata_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

interface EntryRow {
  id: string;
  type: string;
  title: string;
  content: string;
  tags_json: string;
  domain: string | null;
  status: string;
}

export async function runGraphBuild(options: GraphBuildOptions = {}): Promise<string> {
  const dir = resolve(options.cwd ?? process.cwd());
  const dbPath = resolveDbPath(dir);

  if (!existsSync(dbPath)) {
    return options.json
      ? JSON.stringify({ error: 'Database not found. Run `kivo init` first.' })
      : '✗ Database not found. Run `kivo init` first.';
  }

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  // Create graph tables
  initGraphSchema(db);

  // Load all active entries
  const rows = db.prepare(`
    SELECT id, type, title, content, tags_json, domain, status
    FROM entries WHERE status = 'active'
  `).all() as EntryRow[];

  if (rows.length === 0) {
    db.close();
    return options.json
      ? JSON.stringify({ nodes: 0, edges: 0, insights: 0 })
      : '✗ No active entries found.';
  }

  // Filter out entries with empty IDs
  const validRows = rows.filter(row => row.id && row.id.trim().length > 0);
  if (validRows.length === 0) {
    db.close();
    return options.json
      ? JSON.stringify({ nodes: 0, edges: 0, insights: 0 })
      : '✗ No valid active entries found.';
  }

  console.log(`Building graph from ${validRows.length} entries...`);

  try {
  // Build in-memory graph
  const graph = new KnowledgeGraph({ semanticThreshold: 0.6 });

  const entries: KnowledgeEntry[] = validRows.map(row => {
    let tags: string[] = [];
    try {
      const parsed = JSON.parse(row.tags_json || '[]');
      // Handle double-encoded JSON strings
      tags = Array.isArray(parsed) ? parsed : typeof parsed === 'string' ? JSON.parse(parsed) : [];
    } catch {
      tags = [];
    }
    return {
      id: row.id,
      type: row.type as KnowledgeEntry['type'],
      title: row.title,
      content: row.content,
      summary: '',
      source: { type: 'document' as const, reference: '', timestamp: new Date() },
      confidence: 0.8,
      status: row.status as 'active',
      tags,
      domain: row.domain ?? undefined,
      createdAt: new Date(),
      updatedAt: new Date(),
      version: 1,
    };
  });

  // Add all entries as nodes
  for (const entry of entries) {
    graph.addEntry(entry);
  }

  // Build tag-based co-occurrence edges
  const tagIndex = new Map<string, string[]>();
  for (const entry of entries) {
    for (const tag of entry.tags) {
      if (!tagIndex.has(tag)) tagIndex.set(tag, []);
      tagIndex.get(tag)!.push(entry.id);
    }
  }

  let edgeCount = 0;
  for (const [, entryIds] of tagIndex) {
    if (entryIds.length < 2 || entryIds.length > 50) continue; // skip too-common tags
    for (let i = 0; i < entryIds.length && i < 20; i++) {
      for (let j = i + 1; j < entryIds.length && j < 20; j++) {
        const strength = 1.0 / entryIds.length; // rarer tags = stronger edges
        graph.addCoOccurrenceEdge(entryIds[i], entryIds[j], Math.min(strength * 2, 1.0));
        edgeCount++;
      }
    }
  }

  // Build domain-based edges (entries in same domain)
  const domainIndex = new Map<string, string[]>();
  for (const entry of entries) {
    if (entry.domain) {
      if (!domainIndex.has(entry.domain)) domainIndex.set(entry.domain, []);
      domainIndex.get(entry.domain)!.push(entry.id);
    }
  }

  for (const [, entryIds] of domainIndex) {
    if (entryIds.length < 2 || entryIds.length > 100) continue;
    for (let i = 0; i < Math.min(entryIds.length, 30); i++) {
      for (let j = i + 1; j < Math.min(entryIds.length, 30); j++) {
        graph.addCoOccurrenceEdge(entryIds[i], entryIds[j], 0.3);
        edgeCount++;
      }
    }
  }

  console.log(`Graph: ${graph.nodeCount} nodes, ${graph.edgeCount} edges`);

  // Run insight engine
  const insightEngine = new GraphInsightEngine({
    maxBridgeDetectionNodes: 200, // limit for performance
  });
  const insightResult = insightEngine.analyze(graph);
  console.log(`Insights: ${insightResult.insights.length} found`);

  // Persist to DB
  const snapshot = graph.snapshot();
  const now = new Date().toISOString();

  const txn = db.transaction(() => {
    // Clear old graph data
    db.exec('DELETE FROM graph_nodes');
    db.exec('DELETE FROM graph_edges');
    db.exec('DELETE FROM graph_insights');

    // Insert nodes
    const insertNode = db.prepare(
      'INSERT INTO graph_nodes (entry_id, type, title, domain, tags_json, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    );
    for (const node of snapshot.nodes) {
      insertNode.run(node.entryId, node.type, node.title, node.domain ?? null, JSON.stringify(node.tags), now);
    }

    // Insert edges
    const insertEdge = db.prepare(
      'INSERT OR IGNORE INTO graph_edges (source_id, target_id, association_type, edge_source, weight, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    );
    for (const edge of snapshot.edges) {
      insertEdge.run(edge.sourceId, edge.targetId, edge.associationType, edge.edgeSource, edge.weight, now);
    }

    // Insert insights
    const insertInsight = db.prepare(
      'INSERT INTO graph_insights (id, type, description, importance, affected_node_ids_json, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    for (const insight of insightResult.insights) {
      insertInsight.run(
        insight.id, insight.type, insight.description, insight.importance,
        JSON.stringify(insight.affectedNodeIds),
        insight.metadata ? JSON.stringify(insight.metadata) : null,
        now
      );
    }
  });
  txn();

  // Store graph metadata
  db.prepare(
    `INSERT INTO kivo_meta (key, value, updated_at) VALUES ('graph:last_build', ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(now);
  db.prepare(
    `INSERT INTO kivo_meta (key, value, updated_at) VALUES ('graph:node_count', ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(String(snapshot.nodes.length));
  db.prepare(
    `INSERT INTO kivo_meta (key, value, updated_at) VALUES ('graph:edge_count', ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(String(snapshot.edges.length));

  db.close();

  const summary = {
    nodes: snapshot.nodes.length,
    edges: snapshot.edges.length,
    insights: insightResult.insights.length,
    domains: snapshot.metadata.domains,
  };

  if (options.json) {
    return JSON.stringify(summary);
  }

  const lines = [
    `✓ Knowledge graph built:`,
    `  Nodes: ${summary.nodes}`,
    `  Edges: ${summary.edges}`,
    `  Insights: ${summary.insights}`,
    `  Domains: ${summary.domains.join(', ') || '(none)'}`,
  ];

  if (insightResult.insights.length > 0) {
    lines.push('', '  Top insights:');
    for (const insight of insightResult.insights.slice(0, 5)) {
      lines.push(`    [${insight.importance}] ${insight.description}`);
    }
  }

  return lines.join('\n');
  } finally {
    db.close();
  }
}
