import Database from 'better-sqlite3';
import type { GovernableIntent, GovernanceReport, GovernanceStore, MergeOperation } from '@self-evolving-harness/kivo';
import { ensureOperationalTables } from '@self-evolving-harness/kivo';
import { resolveKivoDbPath } from '@/lib/db';

export function openWebDb(readonly = false) {
  return new Database(resolveKivoDbPath(), {
    readonly,
    fileMustExist: readonly,
  });
}

function ensureIntentTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS web_governance_intents (
      id TEXT PRIMARY KEY,
      payload_json TEXT NOT NULL,
      governance_status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS web_governance_merge_operations (
      id TEXT PRIMARY KEY,
      payload_json TEXT NOT NULL,
      reverted INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS web_governance_reports (
      id TEXT PRIMARY KEY,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
}

export class WebGovernanceStore implements GovernanceStore {
  private readonly db: Database.Database;
  private readonly closeWhenDone: boolean;

  constructor(db?: Database.Database) {
    this.db = db ?? openWebDb(false);
    this.closeWhenDone = !db;
    ensureOperationalTables(this.db);
    ensureIntentTables(this.db);
  }

  close(): void {
    if (this.closeWhenDone) this.db.close();
  }

  async listActive(): Promise<GovernableIntent[]> {
    const rows = this.db.prepare(`
      SELECT payload_json FROM web_governance_intents
      WHERE governance_status IN ('active', 'pending_cleanup')
      ORDER BY updated_at DESC
    `).all() as Array<{ payload_json: string }>;
    return rows.map((row) => reviveIntent(JSON.parse(row.payload_json) as GovernableIntent));
  }

  async update(intent: GovernableIntent): Promise<void> {
    const normalized = reviveIntent(intent);
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO web_governance_intents (id, payload_json, governance_status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        payload_json = excluded.payload_json,
        governance_status = excluded.governance_status,
        updated_at = excluded.updated_at
    `).run(
      normalized.id,
      JSON.stringify(normalized),
      normalized.governanceStatus,
      normalized.createdAt.toISOString(),
      now,
    );
  }

  async updateMany(intents: GovernableIntent[]): Promise<void> {
    const txn = this.db.transaction((items: GovernableIntent[]) => {
      const now = new Date().toISOString();
      const stmt = this.db.prepare(`
        INSERT INTO web_governance_intents (id, payload_json, governance_status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          payload_json = excluded.payload_json,
          governance_status = excluded.governance_status,
          updated_at = excluded.updated_at
      `);
      for (const intent of items) {
        const normalized = reviveIntent(intent);
        stmt.run(
          normalized.id,
          JSON.stringify(normalized),
          normalized.governanceStatus,
          normalized.createdAt.toISOString(),
          now,
        );
      }
    });
    txn(intents);
  }

  async create(intent: GovernableIntent): Promise<GovernableIntent> {
    const normalized = reviveIntent(intent);
    await this.update(normalized);
    return normalized;
  }

  async saveMergeOperation(op: MergeOperation): Promise<void> {
    const normalized = reviveMergeOperation(op);
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO web_governance_merge_operations (id, payload_json, reverted, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        payload_json = excluded.payload_json,
        reverted = excluded.reverted,
        updated_at = excluded.updated_at
    `).run(
      normalized.id,
      JSON.stringify(normalized),
      normalized.reverted ? 1 : 0,
      normalized.mergedAt.toISOString(),
      now,
    );
  }

  async getMergeOperation(id: string): Promise<MergeOperation | null> {
    const row = this.db.prepare('SELECT payload_json FROM web_governance_merge_operations WHERE id = ?')
      .get(id) as { payload_json: string } | undefined;
    return row ? reviveMergeOperation(JSON.parse(row.payload_json) as MergeOperation) : null;
  }

  async saveReport(report: GovernanceReport): Promise<void> {
    const normalized = reviveGovernanceReport(report);
    this.db.prepare(`
      INSERT INTO web_governance_reports (id, payload_json, created_at)
      VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET payload_json = excluded.payload_json
    `).run(normalized.id, JSON.stringify(normalized), normalized.runAt.toISOString());
  }

  async listReports(limit = 10): Promise<GovernanceReport[]> {
    const rows = this.db.prepare(`
      SELECT payload_json FROM web_governance_reports
      ORDER BY created_at DESC
      LIMIT ?
    `).all(limit) as Array<{ payload_json: string }>;
    return rows.map((row) => reviveGovernanceReport(JSON.parse(row.payload_json) as GovernanceReport));
  }
}

function reviveIntent(intent: GovernableIntent): GovernableIntent {
  return {
    ...intent,
    positives: [...(intent.positives ?? [])],
    negatives: [...(intent.negatives ?? [])],
    linkedEntryIds: [...(intent.linkedEntryIds ?? [])],
    mergedFromIds: intent.mergedFromIds ? [...intent.mergedFromIds] : undefined,
    lastHitAt: intent.lastHitAt ? new Date(intent.lastHitAt) : null,
    createdAt: new Date(intent.createdAt),
  };
}

function reviveMergeOperation(op: MergeOperation): MergeOperation {
  return {
    ...op,
    sourceSnapshots: op.sourceSnapshots.map(reviveIntent),
    mergedAt: new Date(op.mergedAt),
  };
}

function reviveGovernanceReport(report: GovernanceReport): GovernanceReport {
  return {
    ...report,
    runAt: new Date(report.runAt),
    mergeOperations: report.mergeOperations.map(reviveMergeOperation),
    weightChanges: report.weightChanges.map((item) => ({ ...item, changedAt: new Date(item.changedAt) })),
  };
}
