/**
 * SQLiteDomainGoalStore — SQLite-backed domain goal persistence
 *
 * Drop-in replacement for the in-memory DomainGoalStore.
 * Persists domain goals to SQLite for survival across restarts.
 */

import Database from 'better-sqlite3';
import type {
  DomainGoal,
  DomainGoalInput,
  DomainGoalChangeEvent,
  DomainGoalChangeListener,
} from './domain-goal-types.js';

export interface SQLiteDomainGoalStoreOptions {
  db: Database.Database;
}

export class SQLiteDomainGoalStore {
  private readonly db: Database.Database;
  private listeners: DomainGoalChangeListener[] = [];

  constructor(options: SQLiteDomainGoalStoreOptions) {
    this.db = options.db;
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS domain_goals (
        domain_id TEXT PRIMARY KEY,
        purpose TEXT NOT NULL,
        key_questions TEXT NOT NULL DEFAULT '[]',
        non_goals TEXT NOT NULL DEFAULT '[]',
        research_boundary TEXT NOT NULL DEFAULT '',
        priority_signals TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  onChange(listener: DomainGoalChangeListener): () => void {
    this.listeners.push(listener);
    return () => {
      const idx = this.listeners.indexOf(listener);
      if (idx >= 0) this.listeners.splice(idx, 1);
    };
  }

  create(input: DomainGoalInput): DomainGoal {
    const existing = this.get(input.domainId);
    if (existing) {
      throw new Error(`Domain goal already exists: ${input.domainId}`);
    }

    const now = new Date();
    const goal: DomainGoal = {
      domainId: input.domainId,
      purpose: input.purpose,
      keyQuestions: input.keyQuestions ?? [],
      nonGoals: input.nonGoals ?? [],
      researchBoundary: input.researchBoundary ?? '',
      prioritySignals: input.prioritySignals ?? [],
      createdAt: now,
      updatedAt: now,
    };

    this.db.prepare(`
      INSERT INTO domain_goals (domain_id, purpose, key_questions, non_goals, research_boundary, priority_signals, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      goal.domainId, goal.purpose,
      JSON.stringify(goal.keyQuestions), JSON.stringify(goal.nonGoals),
      goal.researchBoundary, JSON.stringify(goal.prioritySignals),
      goal.createdAt.toISOString(), goal.updatedAt.toISOString()
    );

    this.emit({ type: 'created', domainId: goal.domainId, timestamp: now, current: goal });
    return goal;
  }

  update(domainId: string, patch: Partial<Omit<DomainGoalInput, 'domainId'>>): DomainGoal | null {
    const existing = this.get(domainId);
    if (!existing) return null;

    const now = new Date();
    const previous = { ...existing };
    const updated: DomainGoal = {
      ...existing,
      ...(patch.purpose !== undefined && { purpose: patch.purpose }),
      ...(patch.keyQuestions !== undefined && { keyQuestions: patch.keyQuestions }),
      ...(patch.nonGoals !== undefined && { nonGoals: patch.nonGoals }),
      ...(patch.researchBoundary !== undefined && { researchBoundary: patch.researchBoundary }),
      ...(patch.prioritySignals !== undefined && { prioritySignals: patch.prioritySignals }),
      updatedAt: now,
    };

    this.db.prepare(`
      UPDATE domain_goals SET purpose = ?, key_questions = ?, non_goals = ?,
        research_boundary = ?, priority_signals = ?, updated_at = ?
      WHERE domain_id = ?
    `).run(
      updated.purpose, JSON.stringify(updated.keyQuestions),
      JSON.stringify(updated.nonGoals), updated.researchBoundary,
      JSON.stringify(updated.prioritySignals), updated.updatedAt.toISOString(),
      domainId
    );

    this.emit({ type: 'updated', domainId, timestamp: now, previous, current: updated });
    return updated;
  }

  delete(domainId: string): boolean {
    const existing = this.get(domainId);
    if (!existing) return false;

    this.db.prepare('DELETE FROM domain_goals WHERE domain_id = ?').run(domainId);
    this.emit({ type: 'deleted', domainId, timestamp: new Date(), previous: existing });
    return true;
  }

  get(domainId: string): DomainGoal | null {
    const row = this.db.prepare(
      'SELECT * FROM domain_goals WHERE domain_id = ?'
    ).get(domainId) as GoalRow | undefined;

    return row ? rowToGoal(row) : null;
  }

  list(): DomainGoal[] {
    const rows = this.db.prepare('SELECT * FROM domain_goals ORDER BY created_at ASC').all() as GoalRow[];
    return rows.map(rowToGoal);
  }

  has(domainId: string): boolean {
    const row = this.db.prepare(
      'SELECT 1 FROM domain_goals WHERE domain_id = ?'
    ).get(domainId);
    return !!row;
  }

  private emit(event: DomainGoalChangeEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // listener errors should not break the store
      }
    }
  }
}

interface GoalRow {
  domain_id: string;
  purpose: string;
  key_questions: string;
  non_goals: string;
  research_boundary: string;
  priority_signals: string;
  created_at: string;
  updated_at: string;
}

function rowToGoal(row: GoalRow): DomainGoal {
  return {
    domainId: row.domain_id,
    purpose: row.purpose,
    keyQuestions: JSON.parse(row.key_questions),
    nonGoals: JSON.parse(row.non_goals),
    researchBoundary: row.research_boundary,
    prioritySignals: JSON.parse(row.priority_signals),
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}
