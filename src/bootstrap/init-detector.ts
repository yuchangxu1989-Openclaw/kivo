/**
 * InitDetector — 检测 KIVO 是否已完成首次初始化
 *
 * FR-Z02 AC1: 首次启动自动检测是否已完成初始化，未初始化时进入引导流程。
 *
 * 检测逻辑：
 * 1. 数据库文件是否存在（非 :memory: 模式）
 * 2. 数据库中是否有 kivo_meta 表且包含 initialized=true 标记
 */

import { existsSync } from 'node:fs';
import Database from 'better-sqlite3';

export interface InitStatus {
  initialized: boolean;
  dbExists: boolean;
  hasMetaTable: boolean;
  adminCreated: boolean;
  storageConfirmed: boolean;
  providerConfigured: boolean;
}

export function detectInitStatus(dbPath: string): InitStatus {
  const isMemory = dbPath === ':memory:';
  const dbExists = isMemory || existsSync(dbPath);

  if (!dbExists) {
    return {
      initialized: false,
      dbExists: false,
      hasMetaTable: false,
      adminCreated: false,
      storageConfirmed: false,
      providerConfigured: false,
    };
  }

  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: !isMemory });

    const metaTableExists = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='kivo_meta'"
    ).get() !== undefined;

    if (!metaTableExists) {
      return {
        initialized: false,
        dbExists: true,
        hasMetaTable: false,
        adminCreated: false,
        storageConfirmed: false,
        providerConfigured: false,
      };
    }

    const getMeta = (key: string): string | undefined => {
      const row = db!.prepare('SELECT value FROM kivo_meta WHERE key = ?').get(key) as { value: string } | undefined;
      return row?.value;
    };

    return {
      initialized: getMeta('initialized') === 'true',
      dbExists: true,
      hasMetaTable: true,
      adminCreated: getMeta('admin_created') === 'true',
      storageConfirmed: getMeta('storage_confirmed') === 'true',
      providerConfigured: getMeta('provider_configured') === 'true',
    };
  } catch {
    return {
      initialized: false,
      dbExists,
      hasMetaTable: false,
      adminCreated: false,
      storageConfirmed: false,
      providerConfigured: false,
    };
  } finally {
    db?.close();
  }
}
