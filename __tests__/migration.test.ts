import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { MigrationRunner } from '../src/migration/index.js';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  // Create minimal schema that migrations expect
  db.exec(`
    CREATE TABLE IF NOT EXISTS kivo_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS entries (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      summary TEXT,
      source_json TEXT,
      confidence REAL DEFAULT 0.5,
      status TEXT DEFAULT 'active',
      tags_json TEXT DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return db;
}

describe('MigrationRunner (FR-Z10)', () => {
  // ── AC2: 数据完整性校验 ──

  it('checkIntegrity passes on healthy database', () => {
    const db = makeDb();
    const runner = new MigrationRunner(db);
    const result = runner.checkIntegrity();
    expect(result.passed).toBe(true);
    expect(result.checks.length).toBeGreaterThan(0);
    db.close();
  });

  it('checkIntegrity checks core tables', () => {
    const db = makeDb();
    const runner = new MigrationRunner(db);
    const result = runner.checkIntegrity();
    const tableChecks = result.checks.filter(c => c.name.startsWith('表'));
    expect(tableChecks.length).toBeGreaterThan(0);
    expect(tableChecks.every(c => c.passed)).toBe(true);
    db.close();
  });

  // ── Version detection ──

  it('getCurrentVersion returns 0.0.0 for fresh database', () => {
    const db = makeDb();
    const runner = new MigrationRunner(db);
    expect(runner.getCurrentVersion()).toBe('0.0.0');
    db.close();
  });

  it('getPendingMigrations returns all for fresh database', () => {
    const db = makeDb();
    const runner = new MigrationRunner(db);
    const pending = runner.getPendingMigrations();
    expect(pending.length).toBeGreaterThan(0);
    db.close();
  });

  // ── AC1: 迁移执行 ──

  it('migrate applies all pending migrations', () => {
    const db = makeDb();
    const runner = new MigrationRunner(db);
    const result = runner.migrate();

    expect(result.success).toBe(true);
    expect(result.appliedMigrations.length).toBeGreaterThan(0);
    expect(result.fromVersion).toBe('0.0.0');

    // Verify domain_goals table was created
    const tableExists = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='domain_goals'"
    ).get();
    expect(tableExists).toBeTruthy();

    // Verify metrics_log table was created
    const metricsExists = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='metrics_log'"
    ).get();
    expect(metricsExists).toBeTruthy();

    db.close();
  });

  it('migrate is idempotent', () => {
    const db = makeDb();
    const runner = new MigrationRunner(db);

    const first = runner.migrate();
    expect(first.success).toBe(true);
    expect(first.appliedMigrations.length).toBeGreaterThan(0);

    const second = runner.migrate();
    expect(second.success).toBe(true);
    expect(second.appliedMigrations).toHaveLength(0);

    db.close();
  });

  it('migrate to specific version', () => {
    const db = makeDb();
    const runner = new MigrationRunner(db);
    const result = runner.migrate('0.2.0');

    expect(result.success).toBe(true);
    expect(result.toVersion).toBe('0.2.0');

    // domain_goals should exist
    const exists = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='domain_goals'"
    ).get();
    expect(exists).toBeTruthy();

    // metrics_log should NOT exist yet
    const metricsExists = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='metrics_log'"
    ).get();
    expect(metricsExists).toBeFalsy();

    db.close();
  });

  // ── AC3: 回滚 ──

  it('rollback removes applied migrations', () => {
    const db = makeDb();
    const runner = new MigrationRunner(db);

    // Apply all
    const result = runner.migrate();
    expect(result.success).toBe(true);

    // Rollback
    runner.rollback(result.appliedMigrations);

    // domain_goals should be gone
    const exists = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='domain_goals'"
    ).get();
    expect(exists).toBeFalsy();

    db.close();
  });

  // ── AC4: 升级说明 ──

  it('getUpgradeNotes returns notes for all migrations', () => {
    const db = makeDb();
    const runner = new MigrationRunner(db);
    const notes = runner.getUpgradeNotes();
    expect(notes.length).toBeGreaterThan(0);
    expect(notes[0].version).toBeTruthy();
    expect(notes[0].migrationSteps.length).toBeGreaterThan(0);
    db.close();
  });

  it('getRegisteredMigrations returns all scripts', () => {
    const db = makeDb();
    const runner = new MigrationRunner(db);
    const migrations = runner.getRegisteredMigrations();
    expect(migrations.length).toBeGreaterThan(0);
    expect(migrations[0].up).toBeTruthy();
    expect(migrations[0].down).toBeTruthy();
    db.close();
  });
});
