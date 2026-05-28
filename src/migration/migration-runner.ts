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
import { basename, dirname, join as pathJoin } from 'node:path';
import type {
  MigrationScript,
  IntegrityCheckResult,
  IntegrityCheckItem,
  MigrationResult,
  BackupResult,
  UpgradeNotes,
  RollbackResult,
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
    affectedTables: ['entries', 'domain_goals'],
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
    affectedTables: ['metrics_log', 'domain_access_rules'],
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
    affectedTables: ['kivo_migrations'],
  },
  {
    version: '0.4.0',
    description: '为意图条目添加相似句字段 similar_sentences',
    up: "ALTER TABLE entries ADD COLUMN similar_sentences TEXT DEFAULT '[]'",
    down: '', // SQLite does not support DROP COLUMN before 3.35; column remains harmless
    affectedTables: ['entries'],
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
    affectedTables: ['entries'],
  },
  {
    version: '0.6.0',
    description: 'A1+B1+D1: 顶层二分结构 + 多对多关系表 + 分类争议表',
    up: [
      'ALTER TABLE subject_nodes ADD COLUMN deletable INTEGER NOT NULL DEFAULT 1',
      'ALTER TABLE subject_nodes ADD COLUMN wiki_directory_id TEXT',
      'CREATE TABLE IF NOT EXISTS material_subjects (' +
        'material_id TEXT NOT NULL,' +
        'subject_id TEXT NOT NULL,' +
        "role TEXT NOT NULL DEFAULT 'primary'," +
        'confidence REAL DEFAULT 1.0,' +
        "created_at TEXT NOT NULL DEFAULT (datetime('now'))," +
        'PRIMARY KEY (material_id, subject_id)' +
      ')',
      'CREATE INDEX IF NOT EXISTS idx_material_subjects_subject ON material_subjects(subject_id)',
      'CREATE TABLE IF NOT EXISTS entry_subjects (' +
        'entry_id TEXT NOT NULL,' +
        'subject_id TEXT NOT NULL,' +
        "role TEXT NOT NULL DEFAULT 'primary'," +
        'confidence REAL DEFAULT 1.0,' +
        "created_at TEXT NOT NULL DEFAULT (datetime('now'))," +
        'PRIMARY KEY (entry_id, subject_id)' +
      ')',
      'CREATE INDEX IF NOT EXISTS idx_entry_subjects_subject ON entry_subjects(subject_id)',
      'CREATE TABLE IF NOT EXISTS wiki_page_entries (' +
        'wiki_page_id TEXT NOT NULL,' +
        'entry_id TEXT NOT NULL,' +
        "relation TEXT NOT NULL DEFAULT 'contains'," +
        "created_at TEXT NOT NULL DEFAULT (datetime('now'))," +
        'PRIMARY KEY (wiki_page_id, entry_id)' +
      ')',
      'CREATE INDEX IF NOT EXISTS idx_wiki_page_entries_entry ON wiki_page_entries(entry_id)',
      'CREATE TABLE IF NOT EXISTS classification_disputes (' +
        'id TEXT PRIMARY KEY,' +
        'material_id TEXT NOT NULL,' +
        'original_subject_id TEXT,' +
        'suggested_subject_id TEXT,' +
        'reason TEXT,' +
        "status TEXT NOT NULL DEFAULT 'open'," +
        "created_at TEXT NOT NULL DEFAULT (datetime('now'))," +
        'resolved_at TEXT' +
      ')',
      'CREATE INDEX IF NOT EXISTS idx_disputes_material ON classification_disputes(material_id)',
      'CREATE INDEX IF NOT EXISTS idx_disputes_status ON classification_disputes(status)',
    ].join(';\n'),
    down: 'DROP TABLE IF EXISTS classification_disputes;\n' +
      'DROP TABLE IF EXISTS wiki_page_entries;\n' +
      'DROP TABLE IF EXISTS entry_subjects;\n' +
      'DROP TABLE IF EXISTS material_subjects',
    affectedTables: ['subject_nodes', 'material_subjects', 'entry_subjects', 'wiki_page_entries', 'classification_disputes'],
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
        "SELECT version FROM kivo_migrations WHERE status = 'applied' OR (status IS NULL AND success = 1)"
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
    this.ensureMigrationTable();

    for (const migration of pending) {
      try {
        // Execute migration in transaction for atomicity
        const runMigration = this.db.transaction(() => {
          this.db.exec(migration.up);
          this.db.prepare(
            "INSERT OR REPLACE INTO kivo_migrations (version, applied_at, success, status) VALUES (?, CURRENT_TIMESTAMP, 1, 'applied')"
          ).run(migration.version);
        });
        runMigration();
        applied.push(migration.version);
      } catch (err) {
        // AC3: 回滚已执行的迁移
        this.rollbackMany(applied);
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
   * AC3: 回滚迁移列表（保持旧调用兼容）
   */
  rollback(versions: string[]): void;
  /**
   * AC3: 按迁移 id 从备份恢复数据。
   */
  rollback(migrationId: string): RollbackResult;
  rollback(input: string[] | string): void | RollbackResult {
    if (Array.isArray(input)) {
      this.rollbackMany(input);
      return;
    }

    this.ensureMigrationTable();
    const record = this.db.prepare(
      'SELECT version, backup_path FROM kivo_migrations WHERE version = ?'
    ).get(input) as { version: string; backup_path?: string } | undefined;

    if (!record) {
      return { success: false, migrationId: input, error: `未找到迁移记录: ${input}` };
    }
    if (!record.backup_path) {
      return { success: false, migrationId: input, error: `迁移 ${input} 没有关联备份` };
    }
    if (!existsSync(record.backup_path)) {
      return { success: false, migrationId: input, backupPath: record.backup_path, error: `备份不存在: ${record.backup_path}` };
    }

    try {
      this.restoreBackup(record.backup_path);
      this.db.prepare(
        "UPDATE kivo_migrations SET status = 'rolled_back', success = 0 WHERE version = ?"
      ).run(input);
      return { success: true, migrationId: input, backupPath: record.backup_path };
    } catch (err) {
      return {
        success: false,
        migrationId: input,
        backupPath: record.backup_path,
        error: `回滚失败: ${err instanceof Error ? err.message : err}`,
      };
    }
  }

  private rollbackMany(versions: string[]): void {
    // 逆序回滚
    for (const version of [...versions].reverse()) {
      const migration = MIGRATIONS.find(m => m.version === version);
      if (migration) {
        try {
          this.db.exec(migration.down);
          this.db.prepare(
            "UPDATE kivo_migrations SET status = 'rolled_back', success = 0 WHERE version = ?"
          ).run(version);
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
  backup(dbPath: string, backupDir?: string): BackupResult {
    try {
      if (!existsSync(dbPath)) {
        return { success: false, backupPath: '', sizeBytes: 0, error: `数据库文件不存在: ${dbPath}` };
      }

      const targetDir = backupDir ?? dirname(dbPath);
      mkdirSync(targetDir, { recursive: true });

      const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
      const backupName = `${basename(dbPath)}.backup-${timestamp}`;
      const backupPath = pathJoin(targetDir, backupName);

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
   * 备份失败只记录警告，不阻塞迁移。
   */
  migrateWithBackup(dbPath: string, backupDir?: string, targetVersion?: string): MigrationResult & { backupPath?: string; warnings?: string[] } {
    const pending = targetVersion
      ? MIGRATIONS.filter(m => compareVersions(m.version, this.getCurrentVersion()) > 0 && compareVersions(m.version, targetVersion) <= 0)
      : this.getPendingMigrations();

    if (pending.length === 0) {
      const current = this.getCurrentVersion();
      return { success: true, fromVersion: current, toVersion: current, appliedMigrations: [] };
    }

    const warnings: string[] = [];
    const backupResult = this.backup(dbPath, backupDir);
    if (!backupResult.success) {
      warnings.push(backupResult.error ?? '备份失败');
    }

    const result = this.migrate(targetVersion);
    if (backupResult.success) {
      this.attachBackupToMigrations(result.appliedMigrations, backupResult.backupPath);
    }
    return {
      ...result,
      backupPath: backupResult.success ? backupResult.backupPath : undefined,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }

  private ensureMigrationTable(): void {
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS kivo_migrations (' +
      'version TEXT PRIMARY KEY,' +
      'applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,' +
      'success INTEGER NOT NULL DEFAULT 1,' +
      "status TEXT NOT NULL DEFAULT 'applied'," +
      'backup_path TEXT' +
      ')'
    );
    this.ensureMigrationStatusColumns();
  }

  private ensureMigrationStatusColumns(): void {
    this.ensureColumn('kivo_migrations', 'status', "TEXT NOT NULL DEFAULT 'applied'");
    this.ensureColumn('kivo_migrations', 'backup_path', 'TEXT');
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!rows.some(r => r.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }

  private attachBackupToMigrations(versions: string[], backupPath: string): void {
    if (versions.length === 0) return;
    this.ensureMigrationTable();
    for (const version of versions) {
      this.db.prepare('UPDATE kivo_migrations SET backup_path = ? WHERE version = ?').run(backupPath, version);
    }
  }

  private restoreBackup(backupPath: string): void {
    const escaped = backupPath.replace(/'/g, "''");
    this.db.exec(`VACUUM main INTO '${escaped}.restore-current'`);
    this.db.exec(`ATTACH DATABASE '${escaped}' AS kivo_backup`);
    try {
      const tableRows = this.db.prepare(
        "SELECT name FROM kivo_backup.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
      ).all() as { name: string }[];
      const runRestore = this.db.transaction(() => {
        for (const row of tableRows) {
          const table = row.name;
          const quoted = quoteIdent(table);
          this.db.exec(`DROP TABLE IF EXISTS ${quoted}`);
          this.db.exec(`CREATE TABLE ${quoted} AS SELECT * FROM kivo_backup.${quoted}`);
        }
      });
      runRestore();
    } finally {
      this.db.exec('DETACH DATABASE kivo_backup');
    }
  }
}

function quoteIdent(value: string): string {
  return '"' + value.replace(/"/g, '""') + '"';
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
