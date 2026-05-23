/**
 * CLI: kivo migrate — FR-Z10 升级与数据迁移
 *
 * 子命令:
 *   status  — 显示当前版本和待执行迁移
 *   up      — 执行迁移（含自动备份）
 *   notes   — 显示升级说明
 */

import { MigrationRunner, type MigrationDatabase } from '../migration/migration-runner.js';
import { loadEnvConfig } from '../config/env-loader.js';
import { DEFAULT_CONFIG } from '../config/types.js';

function getDbPath(): string {
  const envConfig = loadEnvConfig();
  const config = { ...DEFAULT_CONFIG, ...envConfig };
  return (config as Record<string, unknown>).dbPath as string
    ?? process.env.KIVO_DB_PATH
    ?? 'kivo.db';
}

function getBackupDir(): string {
  return process.env.KIVO_BACKUP_DIR ?? 'backups';
}

async function openDb(dbPath: string): Promise<MigrationDatabase | null> {
  try {
    const mod = await import('better-sqlite3');
    const Database = mod.default ?? mod;
    return new Database(dbPath) as MigrationDatabase;
  } catch {
    return null;
  }
}

export async function runMigrate(subCommand?: string, _args?: string[]): Promise<string> {
  if (subCommand === '--rollback') {
    subCommand = 'rollback';
  }
  if (_args?.[0] === '--rollback') {
    subCommand = 'rollback';
    _args = _args.slice(1);
  }

  const dbPath = getDbPath();
  const db = await openDb(dbPath);

  if (!db) {
    return `错误: 无法打开数据库 ${dbPath}\n提示: 请先运行 kivo init 初始化数据库`;
  }

  const runner = new MigrationRunner(db);

  switch (subCommand) {
    case 'status': {
      const current = runner.getCurrentVersion();
      const pending = runner.getPendingMigrations();
      const lines = [
        `当前数据库版本: ${current}`,
        `待执行迁移: ${pending.length} 个`,
      ];
      if (pending.length > 0) {
        lines.push('');
        for (const m of pending) {
          lines.push(`  ${m.version} — ${m.description}`);
        }
        lines.push('');
        lines.push('运行 kivo migrate up 执行迁移');
      } else {
        lines.push('数据库已是最新版本');
      }
      return lines.join('\n');
    }

    case 'up': {
      const pending = runner.getPendingMigrations();
      if (pending.length === 0) {
        return '数据库已是最新版本，无需迁移';
      }

      const backupDir = getBackupDir();
      const result = runner.migrateWithBackup(dbPath, backupDir);

      const lines: string[] = [];
      if (result.backupPath) {
        lines.push(`备份已创建: ${result.backupPath}`);
      }
      if (result.warnings?.length) {
        for (const warning of result.warnings) {
          lines.push(`警告: ${warning}`);
        }
      }

      if (result.success) {
        lines.push(`迁移成功: ${result.fromVersion} → ${result.toVersion}`);
        lines.push(`已执行 ${result.appliedMigrations.length} 个迁移:`);
        for (const v of result.appliedMigrations) {
          lines.push(`  ✓ ${v}`);
        }
      } else {
        lines.push(`迁移失败: ${result.error}`);
        if (result.appliedMigrations.length > 0) {
          lines.push(`已回滚 ${result.appliedMigrations.length} 个迁移`);
        }
        process.exitCode = 1;
      }
      return lines.join('\n');
    }

    case 'rollback': {
      const migrationId = _args?.[0];
      if (!migrationId) {
        process.exitCode = 1;
        return '用法: kivo migrate rollback <migrationId> 或 kivo migrate --rollback <migrationId>';
      }
      const result = runner.rollback(migrationId);
      if (!result.success) {
        process.exitCode = 1;
        return `回滚失败: ${result.error}`;
      }
      return `回滚成功: ${result.migrationId}\n备份: ${result.backupPath}`;
    }

    case 'notes': {
      const notes = runner.getUpgradeNotes();
      if (notes.length === 0) {
        return '暂无升级说明';
      }
      const lines: string[] = ['KIVO 升级说明', ''];
      for (const note of notes) {
        lines.push(`── v${note.version} ──`);
        if (note.migrationSteps.length > 0) {
          lines.push(`  迁移步骤:`);
          for (const step of note.migrationSteps) {
            lines.push(`    • ${step}`);
          }
        }
        if (note.breakingChanges.length > 0) {
          lines.push(`  破坏性变更:`);
          for (const bc of note.breakingChanges) {
            lines.push(`    ⚠ ${bc}`);
          }
        }
        if (note.knownIssues.length > 0) {
          lines.push(`  已知问题:`);
          for (const issue of note.knownIssues) {
            lines.push(`    ! ${issue}`);
          }
        }
        lines.push('');
      }
      return lines.join('\n');
    }

    default:
      return `kivo migrate — 数据库迁移管理

用法:
  kivo migrate status                 显示当前版本和待执行迁移
  kivo migrate up                     执行迁移（含自动备份）
  kivo migrate rollback <migrationId> 按迁移 id 从备份回滚
  kivo migrate --rollback <id>        同上
  kivo migrate notes                  显示升级说明`;
  }
}
