/**
 * Graph Alignment Checker (FR-G04)
 *
 * Keeps graph_nodes / graph_edges aligned with entries.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import Database from 'better-sqlite3';
import { DEFAULT_CONFIG } from '../config/types.js';

export interface GraphAlignmentIssueCounts {
  orphanNodes: number;
  missingNodes: number;
  staleEdges: number;
  weightDriftEdges: number;
}

export interface GraphAlignmentFixCounts {
  orphanNodesRemoved: number;
  missingNodesCreated: number;
  staleEdgesRemoved: number;
  weightDriftEdgesRecomputed: number;
}

export interface GraphAlignmentReport {
  checkedAt: string;
  durationMs: number;
  dryRun: boolean;
  issues: GraphAlignmentIssueCounts;
  fixes: GraphAlignmentFixCounts;
}

export interface GraphAlignmentRunOptions {
  cwd?: string;
  dbPath?: string;
  dryRun?: boolean;
  json?: boolean;
}

interface EntryRow {
  id: string;
  type: string;
  title: string;
  domain: string | null;
  tags_json: string | null;
  updated_at: string;
}

interface GraphNodeRow {
  entry_id: string;
}

interface GraphEdgeRow {
  id: number;
  source_id: string;
  target_id: string;
  weight: number;
  created_at: string;
}

function resolveDbPath(dir: string, explicit?: string): string {
  if (explicit) return resolve(dir, explicit);
  const configPath = join(dir, 'kivo.config.json');
  let dbPath = process.env.KIVO_DB_PATH ?? String(DEFAULT_CONFIG.dbPath);
  if (!process.env.KIVO_DB_PATH && existsSync(configPath)) {
    const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
    if (typeof raw.dbPath === 'string') dbPath = raw.dbPath;
  }
  return resolve(dir, dbPath);
}

function ensureGraphSchema(db: Database.Database): void {
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
  `);
}

function computeNodeWeight(a: EntryRow, b: EntryRow): number {
  const sameDomain = a.domain && b.domain && a.domain === b.domain ? 0.25 : 0;
  const sameType = a.type === b.type ? 0.15 : 0;
  const tagsA = parseTags(a.tags_json);
  const tagsB = parseTags(b.tags_json);
  const sharedTags = tagsA.filter(tag => tagsB.includes(tag)).length;
  const tagScore = Math.min(0.25, sharedTags * 0.08);
  return Math.max(0.1, Math.min(0.95, 0.35 + sameDomain + sameType + tagScore));
}

function parseTags(raw: string | null): string[] {
  try {
    const parsed = JSON.parse(raw ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function hasWeightDrift(edge: GraphEdgeRow, entriesById: Map<string, EntryRow>): boolean {
  const source = entriesById.get(edge.source_id);
  const target = entriesById.get(edge.target_id);
  if (!source || !target) return false;
  const edgeTime = new Date(edge.created_at).getTime();
  return new Date(source.updated_at).getTime() > edgeTime || new Date(target.updated_at).getTime() > edgeTime;
}

export class GraphAlignmentChecker {
  constructor(private readonly db: Database.Database) {
    ensureGraphSchema(this.db);
  }

  checkAndFix(options: { dryRun?: boolean } = {}): GraphAlignmentReport {
    const started = Date.now();
    const dryRun = options.dryRun ?? false;
    const checkedAt = new Date().toISOString();

    const entries = this.db.prepare(`
      SELECT id, type, title, domain, tags_json, updated_at
      FROM entries
      WHERE status = 'active'
    `).all() as EntryRow[];
    const nodes = this.db.prepare('SELECT entry_id FROM graph_nodes').all() as GraphNodeRow[];
    const edges = this.db.prepare('SELECT id, source_id, target_id, weight, created_at FROM graph_edges').all() as GraphEdgeRow[];

    const entriesById = new Map(entries.map(entry => [entry.id, entry]));
    const entryIds = new Set(entriesById.keys());
    const nodeIds = new Set(nodes.map(node => node.entry_id));

    const orphanNodeIds = nodes.filter(node => !entryIds.has(node.entry_id)).map(node => node.entry_id);
    const missingEntries = entries.filter(entry => !nodeIds.has(entry.id));
    const staleEdges = edges.filter(edge => !entryIds.has(edge.source_id) || !entryIds.has(edge.target_id));
    const driftEdges = edges.filter(edge => entryIds.has(edge.source_id) && entryIds.has(edge.target_id) && hasWeightDrift(edge, entriesById));

    const fixes: GraphAlignmentFixCounts = {
      orphanNodesRemoved: 0,
      missingNodesCreated: 0,
      staleEdgesRemoved: 0,
      weightDriftEdgesRecomputed: 0,
    };

    if (!dryRun) {
      const now = new Date().toISOString();
      const removeNode = this.db.prepare('DELETE FROM graph_nodes WHERE entry_id = ?');
      const removeEdgesForNode = this.db.prepare('DELETE FROM graph_edges WHERE source_id = ? OR target_id = ?');
      const insertNode = this.db.prepare(`
        INSERT OR IGNORE INTO graph_nodes (entry_id, type, title, domain, tags_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      const removeEdge = this.db.prepare('DELETE FROM graph_edges WHERE id = ?');
      const updateEdge = this.db.prepare('UPDATE graph_edges SET weight = ?, created_at = ? WHERE id = ?');

      const tx = this.db.transaction(() => {
        for (const nodeId of orphanNodeIds) {
          const nodeInfo = removeNode.run(nodeId);
          removeEdgesForNode.run(nodeId, nodeId);
          fixes.orphanNodesRemoved += nodeInfo.changes;
        }

        for (const entry of missingEntries) {
          const info = insertNode.run(entry.id, entry.type, entry.title, entry.domain, entry.tags_json ?? '[]', now);
          fixes.missingNodesCreated += info.changes;
        }

        for (const edge of staleEdges) {
          const info = removeEdge.run(edge.id);
          fixes.staleEdgesRemoved += info.changes;
        }

        for (const edge of driftEdges) {
          const source = entriesById.get(edge.source_id);
          const target = entriesById.get(edge.target_id);
          if (!source || !target) continue;
          const info = updateEdge.run(computeNodeWeight(source, target), now, edge.id);
          fixes.weightDriftEdgesRecomputed += info.changes;
        }
      });
      tx();
    }

    return {
      checkedAt,
      durationMs: Date.now() - started,
      dryRun,
      issues: {
        orphanNodes: orphanNodeIds.length,
        missingNodes: missingEntries.length,
        staleEdges: staleEdges.length,
        weightDriftEdges: driftEdges.length,
      },
      fixes,
    };
  }
}

export function formatGraphAlignmentReport(report: GraphAlignmentReport): string {
  const lines: string[] = [];
  lines.push('═══ KIVO Graph Alignment Report ═══');
  lines.push(`Checked at: ${report.checkedAt}`);
  lines.push(`Mode: ${report.dryRun ? 'dry-run' : 'fix'}`);
  lines.push(`Duration: ${report.durationMs}ms`);
  lines.push('Issues:');
  lines.push(`  Orphan nodes:       ${report.issues.orphanNodes}`);
  lines.push(`  Missing nodes:      ${report.issues.missingNodes}`);
  lines.push(`  Stale edges:        ${report.issues.staleEdges}`);
  lines.push(`  Weight drift edges: ${report.issues.weightDriftEdges}`);
  lines.push('Fixes:');
  lines.push(`  Orphan nodes removed:       ${report.fixes.orphanNodesRemoved}`);
  lines.push(`  Missing nodes created:      ${report.fixes.missingNodesCreated}`);
  lines.push(`  Stale edges removed:        ${report.fixes.staleEdgesRemoved}`);
  lines.push(`  Weight drift recomputed:    ${report.fixes.weightDriftEdgesRecomputed}`);
  return lines.join('\n');
}

export async function runGraphAlignment(options: GraphAlignmentRunOptions = {}): Promise<string> {
  const dir = resolve(options.cwd ?? process.cwd());
  const dbPath = resolveDbPath(dir, options.dbPath);
  if (!existsSync(dbPath)) {
    return options.json
      ? JSON.stringify({ error: 'Database not found. Run `kivo init` first.' })
      : '✗ Database not found. Run `kivo init` first.';
  }

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  try {
    const checker = new GraphAlignmentChecker(db);
    const report = checker.checkAndFix({ dryRun: !!options.dryRun });
    return options.json ? JSON.stringify(report, null, 2) : formatGraphAlignmentReport(report);
  } finally {
    db.close();
  }
}
