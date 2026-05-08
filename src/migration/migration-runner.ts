/**
 * MigrationRunner — 升级与数据迁移执行器
 *
 * FR-Z10:
 * - AC1: 每次 schema 变更附带迁移脚本，支持自动迁移
 * - AC2: 升级前自动执行数据完整性校验
 * - AC3: 升级失败支持回滚到升级前状态
 * - AC4: 升级说明文档
 */

import { existsSync, mkdirSync, copyFileSync, statSync } from 'node:fs';
import { join as pathJoin } from 'node:path';
import type {
  MigrationScript,
  MigrationRecord,
  IntegrityCheckResult,
  IntegrityCheckItem,
  MigrationResult,
  UpgradeNotes,
  BackupResult,
} from './migration-types.js';

export interface MigrationDatabase {
  exec(sql: string): void;
  prepare(sql: string): { run(...args: unknown[]): void; get(...args: unknown[]): unknown; all(...args: unknown[]): unknown[] };
  transaction<T>(fn: () => T): () => T;
}

// Use CURRENT_TIMESTAMP instead of datetime('now') to avoid quote-mangling in ESM transforms
const DT = 'CURRENT_TIMESTAMP';

/** 迁移脚本注册表 — 按版本排序 */
const MIGRATIONS: MigrationScript[] = [
  {
    version: '0.2.0',
    description: '添加 domain 字段和域目标表',
    up: [
      "ALTER TABLE entries ADD COLUMN domain TEXT DEFAULT 'default'",
      'CREATE TABLE IF NOT EXISTS domain_goals (' +
        'domain_id TEXT PRIMARY KEY,' +
        'purpose TEXT NOT NULL,' +
        "key_questions TEXT NOT NULL DEFAULT '[]'," +
        "non_goals TEXT NOT NULL DEFAULT '[]'," +
        "research_boundary TEXT NOT NULL DEFAULT ''," +
        "priority_signals TEXT NOT NULL DEFAULT '[]'," +
        'created_at TEXT NOT NULL DEFAULT ' + DT + ',' +
        'updated_at TEXT NOT NULL DEFAULT ' + DT +
      ')',
    ].join(';\n'),
    down: 'DROP TABLE IF EXISTS domain_goals',
  },
  {
    version: '0.3.0',
    description: '添加度量记录表和访问控制表',
    up: [
      'CREATE TABLE IF NOT EXISTS metrics_log (' +
        'id INTEGER PRIMARY KEY AUTOINCREMENT,' +
        'metric_type TEXT NOT NULL,' +
        'data TEXT NOT NULL,' +
        'timestamp TEXT NOT NULL DEFAULT ' + DT +
      ')',
      'CREATE TABLE IF NOT EXISTS domain_access_rules (' +
        'domain_id TEXT NOT NULL,' +
        'role TEXT NOT NULL,' +
        'PRIMARY KEY (domain_id, role)' +
      ')',
    ].join(';\n'),
    down: 'DROP TABLE IF EXISTS domain_access_rules;\nDROP TABLE IF EXISTS metrics_log',
  },
  {
    version: '0.3.1',
    description: '添加迁移记录表',
    up: 'CREATE TABLE IF NOT EXISTS kivo_migrations (' +
      'version TEXT PRIMARY KEY,' +
      'applied_at TEXT NOT NULL DEFAULT ' + DT + ',' +
      'success INTEGER NOT NULL DEFAULT 1' +
    ')',
    down: 'DROP TABLE IF EXISTS kivo_migrations',
  },
  {
    version: '0.4.0',
    description: '为意图条目添加相似句字段 similar_sentences',
    up: "ALTER TABLE entries ADD COLUMN similar_sentences TEXT DEFAULT '[]'",
    down: '', // SQLite does not support DROP COLUMN before 3.35; column remains harmless
  },
  {
    version: '0.5.0',
    description: 'FR-B05: 多维知识标签 nature/function_tag/knowledge_domain',
    up: [
      'ALTER TABLE entries ADD COLUMN nature TEXT',
      'ALTER TABLE entries ADD COLUMN function_tag TEXT',
      'ALTER TABLE entries ADD COLUMN knowledge_domain TEXT',
    ].join(';\n'),
    down: '', // SQLite < 3.35 cannot DROP COLUMN; columns remain harmless if empty
  },
];

export class MigrationRunner {
  constructor(private readonly db: MigrationDatabase) {}

  /**
   * AC2: 升级前数据完整性校验
   */
  checkIntegrity(): IntegrityCheckResult {
    const checks: IntegrityCheckItem[] = [];

    // SQLite integrity check
    try {
      const result = this.db.prepare('PRAGMA integrity_check').get() as { integrity_check: string } | undefined;
      const ok = result?.integrity_check === 'ok';
      checks.push({
        name: 'SQLite 完整性',
        passed: ok,
        detail: ok ? '数据库完整性校验通过' : `完整性校验失败: ${result?.integrity_check}`,
      });
    } catch (err) {
      checks.push({
        name: 'SQLite 完整性',
        passed: false,
        detail: `校验异常: ${err instanceof Error ? err.message : err}`,
      });
    }

    // Check core tables exist
    const coreTables = ['entries', 'kivo_meta'];
    for (const table of coreTables) {
      try {
        const exists = this.db.prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name=?"
        ).get(table);
        checks.push({
          name: `表 ${table}`,
          passed: !!exists,
          detail: exists ? `表 ${table} 存在` : `表 ${table} 不存在`,
        });
      } catch (err) {
        checks.push({
          name: `表 ${table}`,
          passed: false,
          detail: `检查异常: ${err instanceof Error ? err.message : err}`,
        });
      }
    }

    return {
      passed: checks.every(c => c.passed),
      checks,
    };
  }

  /**
   * 获取当前数据库版本
   */
  getCurrentVersion(): string {
    try {
      const exists = this.db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='kivo_migrations'"
      ).get();
      if (!exists) return '0.0.0';

      const rows = this.db.prepare(
        'SELECT version FROM kivo_migrations WHERE success = 1'
      ).all() as { version: string }[];
      if (rows.length === 0) return '0.0.0';

      // Return the highest version
      let max = '0.0.0';
      for (const row of rows) {
        if (compareVersions(row.version, max) > 0) {
          max = row.version;
        }
      }
      return max;
    } catch {
      return '0.0.0';
    }
  }

  /**
   * 获取待执行的迁移脚本
   */
  getPendingMigrations(): MigrationScript[] {
    const current = this.getCurrentVersion();
    return MIGRATIONS.filter(m => compareVersions(m.version, current) > 0);
  }

  /**
   * AC1: 执行迁移
   * AC3: 失败时回滚
   */
  migrate(targetVersion?: string): MigrationResult {
    const current = this.getCurrentVersion();
    const pending = targetVersion
      ? MIGRATIONS.filter(m => compareVersions(m.version, current) > 0 && compareVersions(m.version, targetVersion) <= 0)
      : this.getPendingMigrations();

    if (pending.length === 0) {
      return {
        success: true,
        fromVersion: current,
        toVersion: current,
        appliedMigrations: [],
      };
    }

    // AC2: 升级前完整性校验
    const integrity = this.checkIntegrity();
    if (!integrity.passed) {
      const failedChecks = integrity.checks.filter(c => !c.passed).map(c => c.detail).join('; ');
      return {
        success: false,
        fromVersion: current,
        toVersion: current,
        appliedMigrations: [],
        error: `数据完整性校验不通过: ${failedChecks}`,
      };
    }

    const applied: string[] = [];

    // Ensure migrations table exists first
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS kivo_migrations (' +
      'version TEXT PRIMARY KEY,' +
      'applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,' +
      'success INTEGER NOT NULL DEFAULT 1' +
      ')'
    );

    for (const migration of pending) {
      try {
        // Execute migration in transaction for atomicity
        const runMigration = this.db.transaction(() => {
          this.db.exec(migration.up);
          this.db.prepare(
            'INSERT OR REPLACE INTO kivo_migrations (version, applied_at, success) VALUES (?, CURRENT_TIMESTAMP, 1)'
          ).run(migration.version);
        });
        runMigration();
        applied.push(migration.version);
      } catch (err) {
        // AC3: 回滚已执行的迁移
        this.rollback(applied);
        return {
          success: false,
          fromVersion: current,
          toVersion: applied.length > 0 ? applied[applied.length - 1] : current,
          appliedMigrations: applied,
          error: `迁移 ${migration.version} 失败: ${err instanceof Error ? err.message : err}`,
        };
      }
    }

    return {
      success: true,
      fromVersion: current,
      toVersion: pending[pending.length - 1].version,
      appliedMigrations: applied,
    };
  }

  /**
   * AC3: 回滚迁移
   */
  rollback(versions: string[]): void {
    // 逆序回滚
    for (const version of [...versions].reverse()) {
      const migration = MIGRATIONS.find(m => m.version === version);
      if (migration) {
        try {
          this.db.exec(migration.down);
          this.db.prepare('DELETE FROM kivo_migrations WHERE version = ?').run(version);
        } catch {
          // 回滚失败时继续尝试其他版本
        }
      }
    }
  }

  /**
   * AC4: 获取升级说明
   */
  getUpgradeNotes(): UpgradeNotes[] {
    return MIGRATIONS.map(m => ({
      version: m.version,
      breakingChanges: [],
      migrationSteps: [m.description],
      knownIssues: [],
    }));
  }

  /** 获取所有已注册的迁移脚本 */
  getRegisteredMigrations(): MigrationScript[] {
    return [...MIGRATIONS];
  }

  /**
   * 迁移前自动备份数据库
   * 将当前数据库文件复制到 backupDir，文件名含版本号和时间戳
   */
  backup(dbPath: string, backupDir: string): BackupResult {
    try {
      if (!existsSync(dbPath)) {
        return { success: false, backupPath: '', sizeBytes: 0, error: `数据库文件不存在: ${dbPath}` };
      }

      mkdirSync(backupDir, { recursive: true });

      const version = this.getCurrentVersion();
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupName = `kivo-backup-v${version}-${timestamp}.db`;
      const backupPath = pathJoin(backupDir, backupName);

      copyFileSync(dbPath, backupPath);
      const stats = statSync(backupPath);

      return {
        success: true,
        backupPath,
        sizeBytes: stats.size,
      };
    } catch (err) {
      return {
        success: false,
        backupPath: '',
        sizeBytes: 0,
        error: `备份失败: ${err instanceof Error ? err.message : err}`,
      };
    }
  }

  /**
   * 带备份的迁移（组合 backup + migrate）
   */
  migrateWithBackup(dbPath: string, backupDir: string, targetVersion?: string): MigrationResult & { backupPath?: string } {
    const pending = targetVersion
      ? MIGRATIONS.filter(m => compareVersions(m.version, this.getCurrentVersion()) > 0 && compareVersions(m.version, targetVersion) <= 0)
      : this.getPendingMigrations();

    if (pending.length === 0) {
      const current = this.getCurrentVersion();
      return { success: true, fromVersion: current, toVersion: current, appliedMigrations: [] };
    }

    const backupResult = this.backup(dbPath, backupDir);
    if (!backupResult.success) {
      return {
        success: false,
        fromVersion: this.getCurrentVersion(),
        toVersion: this.getCurrentVersion(),
        appliedMigrations: [],
        error: `备份失败，中止迁移: ${backupResult.error}`,
      };
    }

    const result = this.migrate(targetVersion);
    return { ...result, backupPath: backupResult.backupPath };
  }
}

/** 简单版本比较 */
function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
