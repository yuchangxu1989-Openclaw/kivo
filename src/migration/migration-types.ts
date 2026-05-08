/**
 * Migration Types — 升级与数据迁移
 *
 * FR-Z10:
 * - AC1: schema 变更附带迁移脚本
 * - AC2: 升级前数据完整性校验
 * - AC3: 升级失败支持回滚
 * - AC4: 升级说明文档
 */

export interface MigrationScript {
  version: string;
  description: string;
  up: string;   // SQL for upgrade
  down: string;  // SQL for rollback
}

export interface MigrationRecord {
  version: string;
  appliedAt: string;
  success: boolean;
}

export interface IntegrityCheckResult {
  passed: boolean;
  checks: IntegrityCheckItem[];
}

export interface IntegrityCheckItem {
  name: string;
  passed: boolean;
  detail: string;
}

export interface MigrationResult {
  success: boolean;
  fromVersion: string;
  toVersion: string;
  appliedMigrations: string[];
  error?: string;
}

export interface UpgradeNotes {
  version: string;
  breakingChanges: string[];
  migrationSteps: string[];
  knownIssues: string[];
}

export interface BackupResult {
  success: boolean;
  backupPath: string;
  sizeBytes: number;
  error?: string;
}
