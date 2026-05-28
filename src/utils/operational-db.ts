import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { DEFAULT_CONFIG } from '../config/types.js';

export interface OperationalDbOptions {
  cwd?: string;
  dbPath?: string;
  readonly?: boolean;
}

export function resolveOperationalDbPath(options: OperationalDbOptions = {}): string {
  if (options.dbPath) {
    return resolve(options.cwd ?? process.cwd(), options.dbPath);
  }

  const cwd = resolve(options.cwd ?? process.cwd());
  const configPath = join(cwd, 'kivo.config.json');
  let dbPath = process.env.KIVO_DB_PATH ?? String(DEFAULT_CONFIG.dbPath);

  if (!process.env.KIVO_DB_PATH && existsSync(configPath)) {
    try {
      const raw = JSON.parse(readFileSync(configPath, 'utf-8')) as { dbPath?: unknown };
      if (typeof raw.dbPath === 'string' && raw.dbPath.trim()) {
        dbPath = raw.dbPath;
      }
    } catch {
      // Fall back to default DB path when config is unreadable.
    }
  }

  return resolve(cwd, dbPath);
}

export function openOperationalDb(options: OperationalDbOptions = {}): Database.Database {
  const dbPath = resolveOperationalDbPath(options);
  if (!(options.readonly ?? false)) {
    mkdirSync(dirname(dbPath), { recursive: true });
  }

  const db = new Database(dbPath, {
    readonly: options.readonly ?? false,
    fileMustExist: options.readonly ?? false,
  });

  if (!options.readonly) {
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
  }

  return db;
}

export function ensureOperationalTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS governance_reports (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      processed_count INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'completed',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS graph_error_logs (
      id TEXT PRIMARY KEY,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL,
      metadata_json TEXT
    );

    CREATE TABLE IF NOT EXISTS merge_snapshots (
      merge_id TEXT PRIMARY KEY,
      merged_entry_json TEXT NOT NULL,
      original_entries_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS governance_snapshots (
      operation_id TEXT PRIMARY KEY,
      operation_type TEXT NOT NULL,
      before_state_json TEXT NOT NULL,
      after_state_json TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS distribution_alerts (
      id TEXT PRIMARY KEY,
      rule_id TEXT NOT NULL,
      error TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      handled INTEGER NOT NULL DEFAULT 0,
      metadata_json TEXT
    );

    CREATE TABLE IF NOT EXISTS research_scheduler_runs (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      priority TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_governance_reports_type_created_at ON governance_reports(type, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_graph_error_logs_created_at ON graph_error_logs(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_governance_snapshots_created_at ON governance_snapshots(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_distribution_alerts_handled_timestamp ON distribution_alerts(handled, timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_research_scheduler_runs_created_at ON research_scheduler_runs(created_at DESC);
  `);
}
