/**
 * FR-4 AC-4.4, AC-4.9 | NFR-8
 * Conflict resolver: manages conflict marking, user decisions, and resolution state.
 */

import type { WikiEntryRecord } from '../types.js';
import type { ConflictPair } from './conflict-detector.js';

export type ConflictStatus = 'pending' | 'resolved' | 'dismissed';
export type ResolutionAction = 'keep_both' | 'keep_a' | 'keep_b' | 'merge' | 'dismiss';

export interface ConflictRecord {
  id: string;
  entryAId: string;
  entryBId: string;
  similarity: number;
  llmExplanation: string;
  status: ConflictStatus;
  resolution?: ResolutionAction;
  resolvedAt?: string;
  resolvedBy?: string;
  createdAt: string;
}

export interface ResolveInput {
  conflictId: string;
  action: ResolutionAction;
  resolvedBy?: string;
}

export interface ConflictSummary {
  total: number;
  pending: number;
  resolved: number;
  dismissed: number;
}

/**
 * Manages conflict lifecycle: creation, querying, and resolution.
 * Stores conflict records in the wiki database.
 */
export class ConflictResolver {
  private db: any;

  constructor(db: any) {
    this.db = db;
    this.ensureTable();
  }

  /**
   * Creates the conflicts table if it doesn't exist.
   */
  private ensureTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS wiki_conflicts (
        id TEXT PRIMARY KEY,
        entry_a_id TEXT NOT NULL,
        entry_b_id TEXT NOT NULL,
        similarity REAL NOT NULL,
        llm_explanation TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'pending',
        resolution TEXT,
        resolved_at TEXT,
        resolved_by TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_wiki_conflicts_status ON wiki_conflicts(status);
      CREATE INDEX IF NOT EXISTS idx_wiki_conflicts_entries ON wiki_conflicts(entry_a_id, entry_b_id);
    `);
  }

  /**
   * Records detected conflicts from the conflict detector.
   * Deduplicates by entry pair.
   */
  recordConflicts(conflicts: ConflictPair[]): ConflictRecord[] {
    const records: ConflictRecord[] = [];
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO wiki_conflicts (id, entry_a_id, entry_b_id, similarity, llm_explanation, status, created_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?)
    `);

    const tx = this.db.transaction(() => {
      for (const conflict of conflicts) {
        // Normalize pair order for deduplication
        const [idA, idB] = [conflict.entryA.id, conflict.entryB.id].sort();
        const id = `conflict:${idA}:${idB}`;
        const now = new Date().toISOString();

        insert.run(id, idA, idB, conflict.similarity, conflict.llmExplanation, now);

        records.push({
          id,
          entryAId: idA,
          entryBId: idB,
          similarity: conflict.similarity,
          llmExplanation: conflict.llmExplanation,
          status: 'pending',
          createdAt: now,
        });
      }
    });
    tx();

    return records;
  }

  /**
   * Resolves a conflict with a user decision.
   */
  resolve(input: ResolveInput): ConflictRecord | null {
    const now = new Date().toISOString();

    this.db.prepare(`
      UPDATE wiki_conflicts
      SET status = 'resolved', resolution = ?, resolved_at = ?, resolved_by = ?
      WHERE id = ? AND status = 'pending'
    `).run(input.action, now, input.resolvedBy ?? null, input.conflictId);

    return this.getById(input.conflictId);
  }

  /**
   * Dismisses a conflict (user decides it's not a real conflict).
   */
  dismiss(conflictId: string, resolvedBy?: string): ConflictRecord | null {
    const now = new Date().toISOString();

    this.db.prepare(`
      UPDATE wiki_conflicts
      SET status = 'dismissed', resolution = 'dismiss', resolved_at = ?, resolved_by = ?
      WHERE id = ? AND status = 'pending'
    `).run(now, resolvedBy ?? null, conflictId);

    return this.getById(conflictId);
  }

  /**
   * Lists conflicts by status.
   */
  list(status?: ConflictStatus): ConflictRecord[] {
    const query = status
      ? `SELECT * FROM wiki_conflicts WHERE status = ? ORDER BY created_at DESC`
      : `SELECT * FROM wiki_conflicts ORDER BY created_at DESC`;

    const rows = status
      ? this.db.prepare(query).all(status)
      : this.db.prepare(query).all();

    return rows.map((row: any) => this.mapRow(row));
  }

  /**
   * Gets pending conflicts for a specific entry.
   */
  getForEntry(entryId: string): ConflictRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM wiki_conflicts
      WHERE (entry_a_id = ? OR entry_b_id = ?) AND status = 'pending'
      ORDER BY similarity DESC
    `).all(entryId, entryId);

    return rows.map((row: any) => this.mapRow(row));
  }

  /**
   * Gets a conflict by ID.
   */
  getById(id: string): ConflictRecord | null {
    const row = this.db.prepare(`SELECT * FROM wiki_conflicts WHERE id = ?`).get(id);
    return row ? this.mapRow(row) : null;
  }

  /**
   * Returns a summary of conflict counts by status.
   */
  summary(): ConflictSummary {
    const rows = this.db.prepare(`
      SELECT status, COUNT(*) as count FROM wiki_conflicts GROUP BY status
    `).all() as Array<{ status: string; count: number }>;

    const counts: Record<string, number> = {};
    for (const row of rows) {
      counts[row.status] = row.count;
    }

    return {
      total: (counts['pending'] ?? 0) + (counts['resolved'] ?? 0) + (counts['dismissed'] ?? 0),
      pending: counts['pending'] ?? 0,
      resolved: counts['resolved'] ?? 0,
      dismissed: counts['dismissed'] ?? 0,
    };
  }

  private mapRow(row: any): ConflictRecord {
    return {
      id: row.id,
      entryAId: row.entry_a_id,
      entryBId: row.entry_b_id,
      similarity: row.similarity,
      llmExplanation: row.llm_explanation,
      status: row.status,
      resolution: row.resolution ?? undefined,
      resolvedAt: row.resolved_at ?? undefined,
      resolvedBy: row.resolved_by ?? undefined,
      createdAt: row.created_at,
    };
  }
}
